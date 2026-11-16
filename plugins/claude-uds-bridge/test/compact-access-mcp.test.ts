import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { z } from 'zod';
import { compactFixture } from './compact-fixture';

test('only the human dialog changes compact access and cancel leaves it unchanged', async () => {
  const f = await compactFixture();
  const client = new Client({ name: 'compact-access-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let accept = false;
  client.setRequestHandler(ElicitRequestSchema, async () => accept
    ? { action: 'accept', content: { setting: `allow:${f.peerId}` } } : { action: 'cancel' });
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

test('only accepted human selection enables profile trust, even without Claude sessions; inactive grants can be revoked', async () => {
  const f = await compactFixture();
  const client = new Client({ name: 'profile-access-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let selection = 'all-claude';
  let action: 'accept' | 'cancel' | 'decline' = 'cancel';
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.mode === 'url') throw new Error('Expected the native settings form');
    const schema = z.object({ properties: z.object({ setting: z.object({ enum: z.array(z.string()) }) }) }).parse(request.params.requestedSchema);
    expect(schema.properties.setting.enum).toContain('all-claude');
    expect(schema.properties.setting.enum).toContain('per-chat');
    return { action, ...(action === 'accept' && { content: { setting: selection } }) };
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const call = (args = {}) => client.callTool({ name: 'compact_access', arguments: args, _meta: { threadId: f.desktop.threadId } });
    // Model-supplied arguments cannot stand in for the human's form selection.
    await call({ setting: 'all-claude', mode: 'all-claude' });
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    action = 'decline';
    await call();
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    f.bridge.setCompactAccess(f.peerId, true);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(f.configDir, 'sessions', `${process.ppid}.json`));
    action = 'accept';
    const enabled = await call();
    expect(enabled.isError).not.toBe(true);
    expect(f.bridge.status().compactAccessMode).toBe('all-claude');
    selection = 'per-chat';
    await call();
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    expect(f.bridge.status().compactAccess).toEqual([f.peerId]);
    selection = `revoke:${f.peerId}`;
    await call();
    expect(f.bridge.status().compactAccess).toEqual([]);
    selection = `allow:${f.peerId}`;
    const invalid = await call();
    expect(invalid.isError).toBe(true);
    expect(f.bridge.status().compactAccessMode).toBe('per-chat');
    expect(f.bridge.status().compactAccess).toEqual([]);
  } finally { await client.close(); await f.close(); }
});
