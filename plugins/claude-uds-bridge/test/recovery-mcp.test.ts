import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Database } from 'bun:sqlite';
import { join, resolve, dirname } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge';
import { peers } from '../src/claude';
import { receiver } from './desktop-fixture';

test('MCP restores an inactive current chat through a read-only trusted-hook query and preserves held input', async () => {
  const root = mkdtempSync('/tmp/uds-recovery-mcp-');
  const desktop = await receiver('active', false, false, root, 13);
  const configDir = join(root, 'claude');
  const stateDir = join(root, 'plugin-state', 'claude-uds-bridge');
  const mcpEntry = process.env.UDS_MCP_TEST_ENTRYPOINT ?? resolve(import.meta.dir, '../src/server.ts');
  const pluginRoot = dirname(dirname(mcpEntry));
  const bin = join(root, 'bin'), methods = join(root, 'reader-methods.jsonl');
  mkdirSync(bin, { mode: 0o700 });
  const fakeCodex = join(bin, 'codex');
  // Mock only the standard read-only Codex JSON-RPC endpoint, not the bridge recovery.
  writeFileSync(fakeCodex, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);if(r.id===undefined)continue;
 appendFileSync(${JSON.stringify(methods)},r.method+'\\n');
 const result=r.method==='initialize'?{}:{data:[{cwd:r.params.cwds[0],errors:[],hooks:[{
 eventName:'sessionStart',enabled:true,trustStatus:'trusted',pluginId:'claude-uds-bridge@leonkohli',
 currentHash:'fixture-definition/fixture-content',sourcePath:${JSON.stringify(join(pluginRoot, 'hooks/hooks.json'))},
 handlerType:'mcpTool',server:'claude_uds_bridge',tool:'session_start'}]}]};
 console.log(JSON.stringify({id:r.id,result}));
}
`, { mode: 0o700 });
  chmodSync(fakeCodex, 0o700);
  const original = new Bridge(desktop.threadId, configDir, stateDir, desktop.path);
  original.beginSession(); original.endSession(); await original.close();
  const db = new Database(join(stateDir, `${desktop.threadId}.sqlite`));
  const held = randomUUID(), deadline = Date.now() + 300000;
  db.run("INSERT INTO messages(id,peer_id,direction,text,status,expires_at,from_mode) VALUES (?,?,'in','held input','held',?,'bypass')", [held, randomUUID(), deadline]);
  db.run('UPDATE dialogue_budget SET used=99');
  const client = new Client({ name: 'recovery-integration', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: root, CLAUDE_CONFIG_DIR: configDir,
      CODEX_THREAD_ID: desktop.threadId, TMPDIR: root,
    } }));
    const call = () => client.callTool({ name: 'recover_receiver', arguments: {}, _meta: { threadId: desktop.threadId } });
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('restored');
    expect(peers(configDir).filter(peer => peer.sessionId === desktop.threadId)).toHaveLength(1);
    expect(db.query('SELECT status,expires_at FROM messages WHERE id=?').get(held)).toEqual({ status: 'held', expires_at: deadline });
    expect(db.query('SELECT used FROM dialogue_budget').get()).toEqual({ used: 99 });
    const owner = peers(configDir).find(peer => peer.sessionId === desktop.threadId)!.pid;
    const again = await call();
    expect(JSON.stringify(again)).toContain('receiver_active');
    expect(peers(configDir).find(peer => peer.sessionId === desktop.threadId)?.pid).toBe(owner);
    expect(readFileSync(methods, 'utf8').trim().split('\n')).toEqual(['initialize', 'hooks/list']);
    expect(desktop.submissions).toHaveLength(0);
  } finally {
    await client.close();
    for (const peer of peers(configDir)) if (peer.sessionId === desktop.threadId) process.kill(peer.pid, 'SIGTERM');
    db.close();
    await Bun.sleep(100);
    await desktop.close();
  }
}, 15000);
