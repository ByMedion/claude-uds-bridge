import { Database } from 'bun:sqlite';
import { chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { frameSchema, privateDirectory, SendRefused, serializeFrame, type Peer } from './claude';

// Independent of the package version. Bump revision only when these instructions change.
export const deliveryHelp = {
  revision: 4,
  text: '[Claude UDS Bridge: messages and compact]\n'
    + 'Send ordinary text with native SendMessage; the Codex recipient receives it in its active turn, or starts a turn when idle (steer). No delivery marker is needed.\n'
    + 'Queue delivery has been withdrawn. Do not use [bridge:queue] or request later priority: these requests are refused, never silently steered.\n'
    + 'To request context compaction of a Codex recipient, send exactly [bridge:compact] as a standalone message. Its human must first allow your Claude session in that chat using compact_access. Requests wait for idle. compact_status/waiting confirms acceptance and explains the initial wait; compact_status/submitted means the native call was accepted, not finished. A separate compact_result reports completed, refused, expired or unknown. If refused with pendingRequestId, wait for that existing request instead of retrying. Status updates are sent at most once per phase, may be skipped near the message limit, and consume the same 100-send budget as replies. Wait for completed before scheduling new work in that chat. For unknown, inspect status instead of retrying.',
};
type Guide = { revision: number; text: string };
const claimLifetimeMs = 20000;

export class DeliveryHelpLedger {
  private db: Database;
  constructor(stateDir: string, private now: () => number = Date.now) {
    privateDirectory(stateDir);
    const path = join(stateDir, 'delivery-help.sqlite');
    this.db = new Database(path, { create: true, strict: true });
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS delivery_help (
          peer_key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
          claim TEXT, claim_until INTEGER NOT NULL DEFAULT 0
        );`);
    } catch (error) { this.db.close(); throw error; }
  }

  claim(key: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid delivery help revision');
    return this.db.transaction(() => {
      const now = this.now();
      const row = this.db.query<{ revision: number; claim: string | null; claim_until: number }, [string]>(
        'SELECT revision,claim,claim_until FROM delivery_help WHERE peer_key=?').get(key);
      if (row && (row.revision >= revision || (row.claim && row.claim_until > now))) return null;
      const claim = randomUUID();
      this.db.run(`INSERT INTO delivery_help (peer_key,claim,claim_until) VALUES (?,?,?)
        ON CONFLICT(peer_key) DO UPDATE SET claim=excluded.claim,claim_until=excluded.claim_until`,
        [key, claim, now + claimLifetimeMs]);
      return claim;
    }).immediate();
  }

  complete(key: string, claim: string, revision: number) {
    this.db.run('UPDATE delivery_help SET revision=max(revision,?),claim=NULL,claim_until=0 WHERE peer_key=? AND claim=?',
      [revision, key, claim]);
  }

  release(key: string, claim: string) {
    this.db.run('UPDATE delivery_help SET claim=NULL,claim_until=0 WHERE peer_key=? AND claim=?', [key, claim]);
  }

  close() { this.db.close(); }
}

async function openLedger(stateDir: string) {
  for (let attempt = 0; ; attempt++) {
    try { return new DeliveryHelpLedger(stateDir); }
    catch (error) {
      const busy = error instanceof Error && 'code' in error && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(error.code));
      if (!busy || attempt >= 4) throw error;
      // Concurrent first opens can race while journal mode/schema is initialized.
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}

function withGuide(frame: unknown, guide: string) {
  const parsed = frameSchema.parse(frame);
  if (parsed.type !== 'user') throw new Error('Delivery help requires a user message');
  const content = parsed.message.content;
  const closing = '\n</cross-session-message>';
  const escaped = guide.replaceAll('</cross-session-message', '<\\/cross-session-message');
  const text = content.endsWith(closing)
    ? content.slice(0, -closing.length) + '\n\n' + escaped + closing : content + '\n\n' + escaped;
  // Preserve the caller's envelope and any additional wire fields.
  const original = frame as Record<string, unknown> & { message: Record<string, unknown> };
  return { ...original, message: { ...original.message, content: text } };
}

export async function withDeliveryHelp(
  stateDir: string, configDir: string, peer: Peer, frames: unknown[],
  send: (frames: unknown[]) => Promise<boolean>, guide: Guide = deliveryHelp,
) {
  const index = frames.findIndex(frame => frameSchema.safeParse(frame).data?.type === 'user');
  if (index < 0 || peer.entrypoint === 'codex-claude-uds-bridge') return send(frames);
  const key = createHash('sha256').update(realpathSync(configDir)).update('\0').update(peer.sessionId).digest('hex');
  let ledger: DeliveryHelpLedger;
  try { ledger = await openLedger(stateDir); }
  catch {
    // Guide bookkeeping is not required to deliver the caller's authorized message.
    console.error('Delivery help tracking unavailable; sending the original message.');
    return send(frames);
  }
  let claim: string | null = null;
  try {
    try { claim = ledger.claim(key, guide.revision); }
    catch {
      console.error('Delivery help tracking unavailable; sending the original message.');
      return await send(frames);
    }
    if (!claim) return await send(frames);
    const decorated = [...frames];
    decorated[index] = withGuide(frames[index], guide.text);
    try { serializeFrame(decorated[index]); }
    catch (error) {
      if (!(error instanceof SendRefused)) throw error;
      // Never split or refuse an otherwise valid message just to attach the guide.
      ledger.release(key, claim);
      claim = null;
      return await send(frames);
    }
    const written = await send(decorated);
    if (written) {
      try { ledger.complete(key, claim, guide.revision); }
      catch { console.error('Delivery help write succeeded but tracking could not be updated.'); }
    }
    return written;
  } finally {
    if (claim) {
      try { ledger.release(key, claim); }
      catch { /* An abandoned claim expires; never resend the caller's message. */ }
    }
    try { ledger.close(); } catch { /* Guide bookkeeping cannot undo the send outcome. */ }
  }
}
