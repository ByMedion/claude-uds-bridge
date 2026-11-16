import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..');
export const pluginRoot = join(repoRoot, 'plugins/claude-uds-bridge');
export const packagePath = join(pluginRoot, 'package.json');
export const manifestPath = join(pluginRoot, '.codex-plugin/plugin.json');
export const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function metadata() {
  const pkg = readJson(packagePath), manifest = readJson(manifestPath);
  if (!pkg || !manifest || typeof pkg.name !== 'string' || !pkg.name || typeof pkg.version !== 'string' || !pkg.version
    || pkg.name !== manifest.name || pkg.version !== manifest.version) throw new Error('Package and plugin manifest name/version differ');
  return { pkg, manifest };
}

export async function run(args: string[], cwd = pluginRoot, env: Record<string, string> = {}) {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Command failed (${code}): ${args.join(' ')}`);
}

export function filesUnder(root: string): string[] {
  if (!existsSync(root)) throw new Error(`Missing directory: ${root}`);
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path}`);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

// Same inputs/options as package.json's build; outputs stay outside the worktree.
export async function buildTemporary() {
  const directory = mkdtempSync(join(tmpdir(), 'uds-build-'));
  try {
    const result = await Bun.build({ entrypoints: [join(pluginRoot, 'src/server.ts'), join(pluginRoot, 'src/hook.ts')],
      target: 'bun', minify: true, outdir: directory });
    if (!result.success) throw new Error(result.logs.map(String).join('\n'));
    return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
