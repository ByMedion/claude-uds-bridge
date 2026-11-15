import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { compactFixture } from './compact-fixture';

test('only the human dialog changes compact access and cancel leaves it unchanged', async () => {
  const f = await compactFixture();
  const client = new Client({ name: 'compact-access-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let accept = false;
  client.setRequestHandler(ElicitRequestSchema, async () => accept
    ? { action: 'accept', content: { sessionId: f.peerId, action: 'allow' } } : { action: 'cancel' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const call = (name: string) => client.callTool({ name, arguments: {}, _meta: { threadId: f.desktop.threadId } });
    expect(JSON.stringify(await call('compact_access'))).toContain('cancel');
    let status = await call('status');
    expect(JSON.parse((status.content as { text: string }[])[0]!.text).compactAccess).toEqual([]);
    accept = true;
    const approved = await call('compact_access');
    expect(approved.isError).not.toBe(true);
    status = await call('status');
    expect(JSON.parse((status.content as { text: string }[])[0]!.text).compactAccess).toEqual([f.peerId]);
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === 'compact_access')?.description).toContain('this Codex chat only');
  } finally { await client.close(); await f.close(); }
});
