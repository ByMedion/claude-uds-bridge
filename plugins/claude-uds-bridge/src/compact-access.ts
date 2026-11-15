import { Database } from 'bun:sqlite';
import { uuid } from './claude';

// Kept inside the per-chat database, never shared with other Codex chats.
export class CompactAccess {
  constructor(private db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS compact_access (peer_id TEXT PRIMARY KEY)');
  }
  allows(peerId: string) { return !!this.db.query('SELECT 1 FROM compact_access WHERE peer_id=?').get(peerId); }
  set(peerId: string, allow: boolean) {
    uuid.parse(peerId);
    if (allow) this.db.run('INSERT OR IGNORE INTO compact_access VALUES (?)', [peerId]);
    else this.db.run('DELETE FROM compact_access WHERE peer_id=?', [peerId]);
  }
  list() { return this.db.query<{ peer_id: string }, []>('SELECT peer_id FROM compact_access ORDER BY peer_id').all().map(row => row.peer_id); }
}
