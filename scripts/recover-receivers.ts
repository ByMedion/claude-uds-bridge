import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundleFiles, fail, metadata, pluginRoot, readJson, repoRoot } from './common';

async function main() {
  const args = process.argv.slice(2);
  const help = args.length === 1 && args[0] === '--help';
  let plugin = pluginRoot;
  if (!help) {
    const { pkg } = metadata();
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const marketplace = readJson(join(repoRoot, '.agents/plugins/marketplace.json')).name;
    plugin = join(codexHome, 'plugins/cache', marketplace, pkg.name, pkg.version);
    for (const bundle of bundleFiles) {
      if (!readFileSync(join(plugin, bundle)).equals(readFileSync(join(pluginRoot, bundle)))) {
        throw new Error(`Installed bundle differs from this checkout: ${bundle}`);
      }
    }
  }
  const child = Bun.spawn([process.execPath, join(plugin, 'dist/recover-receivers.js'), ...args],
    { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  process.exitCode = await child.exited;
}

if (import.meta.main) main().catch(fail);
