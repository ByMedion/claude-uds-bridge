import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTemporary, fail, manifestPath, metadata, packagePath, pluginRoot } from './common';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: bun scripts/bump-version.ts [patch|minor|major|X.Y.Z] [--dry-run]'); return; }
  if (args.some(x => x.startsWith('-') && x !== '--dry-run') || args.filter(x => !x.startsWith('-')).length > 1) throw new Error('Invalid arguments; use --help');
  const { pkg } = metadata();
  const parse = (version: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only plain X.Y.Z release versions are supported');
    const numbers = version.split('.').map(Number);
    if (numbers.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid version');
    return numbers;
  };
  const current = parse(pkg.version), next = [...current];
  const requested = args.find(x => !x.startsWith('-')) ?? 'patch';
  const index = ['major', 'minor', 'patch'].indexOf(requested);
  if (index >= 0) { next[index]!++; next.fill(0, index + 1); }
  else next.splice(0, 3, ...parse(requested));
  const changed = next.findIndex((n, i) => n !== current[i]);
  if (changed < 0 || next[changed]! < current[changed]!) throw new Error('New version must be greater than current version');
  const version = next.join('.');
  const updates = [packagePath, manifestPath].map(path => {
    const before = readFileSync(path);
    const after = Buffer.from(before.toString().replace(/(^\s*"version"\s*:\s*")[^"]*(")/m, (_match, prefix: string, suffix: string) => prefix + version + suffix));
    if (JSON.parse(after.toString()).version !== version) throw new Error(`Could not update top-level version: ${path}`);
    return { path, before, after };
  });
  console.log(JSON.stringify({ from: pkg.version, to: version, dryRun: args.includes('--dry-run'), files: ['package.json', '.codex-plugin/plugin.json', 'dist/server.js', 'dist/hook.js'] }));
  if (args.includes('--dry-run')) return;
  const writes: { path: string; before?: Buffer; after: Buffer }[] = [];
  const write = (path: string, after: Buffer, before = existsSync(path) ? readFileSync(path) : undefined) => {
    writeFileSync(path, after); writes.push({ path, before, after });
  };
  try {
    for (const update of updates) {
      if (!readFileSync(update.path).equals(update.before)) throw new Error(`File changed concurrently: ${update.path}`);
      write(update.path, update.after, update.before);
    }
    const build = await buildTemporary();
    try { for (const name of ['server.js', 'hook.js']) write(join(pluginRoot, 'dist', name), readFileSync(join(build.directory, name))); }
    finally { build.cleanup(); }
  } catch (error) {
    for (const entry of writes.reverse()) {
      if (!existsSync(entry.path) || !readFileSync(entry.path).equals(entry.after)) {
        console.error(`Changed concurrently; inspect manually: ${entry.path}`); continue;
      }
      if (entry.before) writeFileSync(entry.path, entry.before); else unlinkSync(entry.path);
    }
    throw error;
  }
  console.log('Version and bundles updated. Review the diff; no commit, push or installation was performed.');
}

if (import.meta.main) main().catch(fail);
