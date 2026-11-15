import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DialogueBudget } from '../src/dialogue';

test('the 100-send budget survives reopen, has no replay reset, and refunds only its own epoch', () => {
  const root = mkdtempSync('/tmp/dialogue-budget-');
  const path = join(root, 'state.sqlite');
  let db = new Database(path);
  let budget = new DialogueBudget(db);
  try {
    budget.observeHuman('human-one');
    const secret = budget.secret();
    for (let i = 0; i < 100; i++) expect(budget.reserve(`send-${i}`)).toBe(true);
    expect(budget.reserve('over-limit')).toBe(false);
    db.close();
    db = new Database(path);
    budget = new DialogueBudget(db);
    expect(budget.secret()).toBe(secret);
    expect(budget.status().remaining).toBe(0);
    budget.observeHuman('human-one');
    expect(budget.reserve('same-human')).toBe(false);
    budget.refund('send-99');
    budget.refund('send-99');
    expect(budget.status().remaining).toBe(1);
    budget.observeHuman('human-two');
    expect(budget.reserve('new-epoch')).toBe(true);
    budget.refund('send-98'); // Late refusal from an old epoch cannot credit this epoch.
    expect(budget.status().used).toBe(1);
    budget.observeHuman('human-one'); // Replayed older native history is not a renewal.
    expect(budget.status().used).toBe(1);
    expect(budget.status().lastHumanInputId).toBe('human-two');
  } finally { db.close(); rmSync(root, { recursive: true }); }
});

test('independent MCP processes share exactly 100 reservations', async () => {
  const root = mkdtempSync('/tmp/dialogue-race-');
  const path = join(root, 'state.sqlite');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const budget = new DialogueBudget(db);
  const children = Array.from({ length: 4 }, (_, worker) => Bun.spawn([process.execPath,
    join(import.meta.dir, 'dialogue-budget-worker.ts'), path, String(worker)], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    const results = await Promise.all(children.map(async child => ({ code: await child.exited,
      out: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    for (const result of results) { expect(result.error).toBe(''); expect(result.code).toBe(0); }
    expect(results.reduce((sum, result) => sum + Number(result.out.trim()), 0)).toBe(100);
    expect(budget.status().used).toBe(100);
  } finally { for (const child of children) child.kill(); db.close(); rmSync(root, { recursive: true }); }
});
