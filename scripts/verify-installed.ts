import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundleFiles, fail, filesUnder, metadata, packagePath, pluginRoot, readJson, repoRoot } from './common';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: bun scripts/verify-installed.ts [--installed-root PATH] [--host]'); return; }
  let installed: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--installed-root' && args[i + 1] && !args[i + 1]!.startsWith('--')) installed = resolve(args[++i]!);
    else if (args[i] !== '--host') throw new Error('Invalid arguments; use --help');
  }
  const { pkg } = metadata();
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const marketplace = readJson(join(repoRoot, '.agents/plugins/marketplace.json'));
  installed ??= join(codexHome, 'plugins/cache', marketplace.name, pkg.name, pkg.version);
  if (!existsSync(installed)) throw new Error('Installed package not found; pass --installed-root from codex plugin add --json');
  const files = ['package.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', ...bundleFiles,
    ...readdirSync(pluginRoot).filter(name => name.endsWith('.md')),
    ...filesUnder(join(pluginRoot, 'skills')).map(path => relative(pluginRoot, path))];
  for (const name of files) assert(readFileSync(join(installed, name)).equals(readFileSync(join(pluginRoot, name))), `Installed file differs: ${name}`);
  const require = createRequire(packagePath);
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const root = mkdtempSync(join(tmpdir(), 'uds-install-check-'));
  const client = new Client({ name: 'bridge-install-verification', version: '1' });
  try {
    const env = { ...process.env };
    Object.assign(env, { CODEX_HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), TMPDIR: root });
    delete env.CODEX_THREAD_ID;
    const batchHelp = Bun.spawnSync([process.execPath, join(installed, 'dist/recover-receivers.js'), '--help'], { cwd: root, env });
    assert.equal(batchHelp.exitCode, 0, batchHelp.stderr.toString());
    assert(batchHelp.stdout.toString().includes('--cwd ABSOLUTE_CHECKOUT'), 'Bundled batch recovery has no usage output');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/server.js')], env }));
    assert.equal(client.getServerVersion()?.version, pkg.version, 'Loaded MCP version differs');
    const listed = await client.listTools();
    const names = listed.tools.map((t: { name: string }) => t.name);
    for (const name of ['list_sessions', 'send_message', 'status', 'diagnose', 'recover_receiver', 'compact_access', 'inbox']) assert(names.includes(name), `Missing tool: ${name}`);
    const result = await client.callTool({ name: 'status', arguments: {}, _meta: { threadId: randomUUID() } });
    assert(!result.isError, 'Isolated status failed');
    const state = JSON.parse(result.content.find((item: { type: string }) => item.type === 'text').text);
    assert.equal(state.pluginVersion, pkg.version); assert.equal(state.replyAddress, null);
    assert.equal(state.compactAccessMode, 'per-chat'); assert.equal(state.automaticMessageBudget.used, 0);
    assert.deepEqual(state.messages, []); assert.deepEqual(state.compactAccess, []);
    console.log(JSON.stringify({ installedVersion: pkg.version, matchedFiles: files.length, tools: names, smoke: 'isolated profile; no real chat or peer contacted' }));
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
  if (args.includes('--host')) {
    const { configuredHooks } = await import(join(pluginRoot, 'src/recovery.ts'));
    const hooks = await configuredHooks(repoRoot, codexHome);
    console.log(JSON.stringify({ hostHooks: hooks.data.flatMap((row: { hooks: { pluginId: string; eventName: string; enabled: boolean; trustStatus: string }[] }) => row.hooks)
      .filter((hook: { pluginId: string }) => hook.pluginId === `${pkg.name}@${marketplace.name}`)
      .map((hook: { eventName: string; enabled: boolean; trustStatus: string }) => ({ event: hook.eventName, enabled: hook.enabled, trust: hook.trustStatus })),
      scope: 'repository cwd; metadata only; live receiver and settings unchanged' }));
  }
}

if (import.meta.main) main().catch(fail);
