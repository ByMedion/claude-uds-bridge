import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge';

test('concurrent MCP opens migrate the compact column once without resetting existing state', async () => {
  const root = mkdtempSync('/tmp/uds-schema-race-'), id = randomUUID();
  const initial = new Bridge(id, root, root, join(root, 'missing.sock'));
  await initial.close();
  const db = new Database(join(root, `${id}.sqlite`));
  db.exec(`DROP INDEX reply_blocked_once;
    ALTER TABLE messages DROP COLUMN parent_message_id;
    UPDATE dialogue_budget SET used=77;`);
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath,
    join(import.meta.dir, 'bridge-schema-worker.ts'), root, id], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    for (const child of children) {
      expect(await child.exited).toBe(0);
      expect((await new Response(child.stdout).text()).trim()).toBe('ok');
      expect(await new Response(child.stderr).text()).toBe('');
    }
    expect(db.query<{ name: string }, []>('PRAGMA table_info(messages)').all().filter(row => row.name === 'parent_message_id')).toHaveLength(1);
    expect(db.query("SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name='reply_blocked_once'").get())
      .toEqual({ count: 1 });
    expect(db.query('SELECT used FROM dialogue_budget').get()).toEqual({ used: 77 });
  } finally { for (const child of children) child.kill(); db.close(); rmSync(root, { recursive: true }); }
});
