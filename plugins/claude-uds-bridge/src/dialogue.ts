import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';

export const automaticMessageLimit = 100;

// Shared by the receiver and every MCP process for this chat. SessionStart and receiver
// restart deliberately do not recreate this state. Human IDs are remembered permanently.
export class DialogueBudget {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS dialogue_budget (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), human_input_id TEXT,
      used INTEGER NOT NULL, secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dialogue_humans (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS dialogue_sends (id TEXT PRIMARY KEY, human_input_id TEXT, charged INTEGER NOT NULL);`);
    db.run('INSERT OR IGNORE INTO dialogue_budget VALUES (1,NULL,0,?)', [randomBytes(32).toString('hex')]);
  }

  observeHuman(id: string) {
    this.db.transaction(() => {
      if (this.db.run('INSERT OR IGNORE INTO dialogue_humans VALUES (?)', [id]).changes) {
        this.db.run('UPDATE dialogue_budget SET human_input_id=?,used=0 WHERE singleton=1', [id]);
      }
    }).immediate();
  }

  // Optional notices can leave capacity for an operation's mandatory result.
  reserve(id: string, spare = 0) {
    return this.db.transaction(() => {
      const state = this.state();
      const old = this.db.query<{ charged: number; human_input_id: string | null }, [string]>(
        'SELECT charged,human_input_id FROM dialogue_sends WHERE id=?').get(id);
      if (old?.charged && old.human_input_id === state.human_input_id) return true;
      if (state.used >= automaticMessageLimit - spare) return false;
      this.db.run('INSERT INTO dialogue_sends VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET human_input_id=excluded.human_input_id,charged=1', [id, state.human_input_id]);
      this.db.run('UPDATE dialogue_budget SET used=used+1 WHERE singleton=1');
      return true;
    }).immediate();
  }

  // Only a definite pre-write refusal refunds a reservation. Unknown outcomes stay charged.
  refund(id: string) {
    this.db.transaction(() => {
      const send = this.db.query<{ human_input_id: string | null }, [string]>(
        'SELECT human_input_id FROM dialogue_sends WHERE id=? AND charged=1').get(id);
      if (!send) return;
      this.db.run('UPDATE dialogue_sends SET charged=0 WHERE id=?', [id]);
      this.db.run('UPDATE dialogue_budget SET used=max(0,used-1) WHERE singleton=1 AND human_input_id IS ?', [send.human_input_id]);
    }).immediate();
  }

  private state() {
    return this.db.query<{ human_input_id: string | null; used: number; secret: string }, []>(
      'SELECT human_input_id,used,secret FROM dialogue_budget WHERE singleton=1').get()!;
  }

  secret() { return this.state().secret; }
  status() {
    const state = this.state();
    return { limit: automaticMessageLimit, used: state.used, remaining: Math.max(0, automaticMessageLimit - state.used),
      lastHumanInputId: state.human_input_id };
  }
}
