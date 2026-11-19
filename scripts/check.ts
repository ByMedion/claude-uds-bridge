import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildTemporary, bundleNames, fail, filesUnder, metadata, pluginRoot, repoRoot, run } from './common';

const usage = 'Usage: bun scripts/check.ts docs | focused test/NAME.test.ts ... | release [--native]';

function checkSkills() {
  for (const file of filesUnder(join(pluginRoot, 'skills')).filter(path => path.endsWith('/SKILL.md'))) {
    const text = readFileSync(file, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!frontmatter) throw new Error(`Missing skill frontmatter: ${file}`);
    const data = Bun.YAML.parse(frontmatter) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64
      || typeof data.description !== 'string' || !data.description.trim()) throw new Error(`Invalid skill name/description: ${file}`);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!.split('#')[0]!;
      if (!link || /^[a-z][a-z\d+.-]*:/i.test(link)) continue;
      const destination = resolve(dirname(file), decodeURIComponent(link));
      const within = relative(pluginRoot, destination);
      if (within.startsWith('..') || isAbsolute(within) || !existsSync(destination)) throw new Error(`Invalid packaged skill link: ${file}: ${link}`);
    }
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--help' || mode === '-h') { console.log(usage); return; }
  if (!['docs', 'focused', 'release'].includes(mode ?? '')) throw new Error(usage);
  if (mode === 'docs' && args.length || mode === 'release' && args.some(x => x !== '--native')) throw new Error(usage);
  if (mode === 'focused') {
    if (!args.length) throw new Error('focused requires explicit test files');
    for (const file of args) {
      if (!/^test\/[\w-]+\.test\.ts$/.test(file) || !existsSync(join(pluginRoot, file))) throw new Error(`Unknown test file: ${file}`);
    }
  }
  if (mode !== 'docs' && !existsSync(join(pluginRoot, 'node_modules/.bin/tsc'))) throw new Error('Install package dependencies with bun install --frozen-lockfile first');
  if (mode === 'release' && args.includes('--native') && !Bun.which('codex')) throw new Error('--native requires Codex CLI on PATH');
  await run(['git', 'diff', '--check'], repoRoot);
  await run(['git', 'diff', '--cached', '--check'], repoRoot);
  metadata(); checkSkills();
  if (mode === 'docs') { console.log('PASS: diff, manifests and packaged skills'); return; }
  await run([process.execPath, 'run', 'check']);
  await run([join(pluginRoot, 'node_modules/.bin/tsc'), '-p', join(repoRoot, 'scripts/tsconfig.json')]);
  if (mode === 'focused') { await run([process.execPath, 'test', ...args]); return; }
  await run([process.execPath, 'test']);
  const build = await buildTemporary();
  try {
    for (const name of bundleNames) {
      if (!readFileSync(join(build.directory, name)).equals(readFileSync(join(pluginRoot, 'dist', name)))) {
        throw new Error(`dist/${name} is stale: run bun run build in the plugin directory`);
      }
    }
  } finally { build.cleanup(); }
  const env = { UDS_MCP_TEST_ENTRYPOINT: join(pluginRoot, 'dist/server.js'), UDS_HOOK_TEST_ENTRYPOINT: join(pluginRoot, 'dist/hook.js') };
  await run([process.execPath, 'test', 'test/compact-access-mcp.test.ts', 'test/recovery-mcp.test.ts', 'test/queue-rollback.test.ts', 'test/manifest.test.ts'], pluginRoot, env);
  if (args.includes('--native')) {
    await run([process.execPath, 'run', 'test:native'], pluginRoot, env);
  } else console.log('SKIPPED: native app-server/model-stub check (add --native to run it)');
  console.log('PASS: release checks; worktree bundles were compared without rewriting them');
}

if (import.meta.main) main().catch(fail);
