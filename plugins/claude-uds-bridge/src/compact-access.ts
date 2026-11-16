import { Database } from 'bun:sqlite';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ownedJson, privateDirectory, uuid } from './claude';

export const compactAccessMode = z.enum(['per-chat', 'all-claude']);
export type CompactAccessMode = z.infer<typeof compactAccessMode>;
const policySchema = z.object({ mode: compactAccessMode }).strict();

export class CompactAccess {
  constructor(private db: Database, private policyPath: string) {
    db.exec('CREATE TABLE IF NOT EXISTS compact_access (peer_id TEXT PRIMARY KEY)');
  }
  // Read on every check so existing receivers observe a profile-wide change.
  mode(): CompactAccessMode {
    privateDirectory(dirname(this.policyPath));
    try { return policySchema.parse(ownedJson(this.policyPath, 4096)).mode; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'per-chat';
      throw error; // Invalid or untrusted settings must never enable compact.
    }
  }
  setMode(value: CompactAccessMode) {
    const mode = compactAccessMode.parse(value);
    privateDirectory(dirname(this.policyPath));
    const temporary = `${this.policyPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ mode }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.policyPath);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  // The caller still authenticates the socket and restricts the sender to Claude.
  allows(peerId: string) {
    return this.mode() === 'all-claude' || !!this.db.query('SELECT 1 FROM compact_access WHERE peer_id=?').get(peerId);
  }
  set(peerId: string, allow: boolean) {
    uuid.parse(peerId);
    if (allow) this.db.run('INSERT OR IGNORE INTO compact_access VALUES (?)', [peerId]);
    else this.db.run('DELETE FROM compact_access WHERE peer_id=?', [peerId]);
  }
  list() { return this.db.query<{ peer_id: string }, []>('SELECT peer_id FROM compact_access ORDER BY peer_id').all().map(row => row.peer_id); }
}
