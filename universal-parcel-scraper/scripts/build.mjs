import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
// The manifest owns the version in both the source contract and its shipped copy.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const contractUrl = new URL('../server/openapi.json', import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, 'utf8'));
if (contract.info.version !== version) {
  contract.info.version = version;
  await writeFile(contractUrl, JSON.stringify(contract, null, 2) + '\n');
}
await rm('dist', { recursive: true, force: true });
const result = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status ?? 1);
const browser = spawnSync('vite', ['build', '--config', 'vite.browser.config.ts'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (browser.status !== 0) process.exit(browser.status ?? 1);
async function assets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { if (!['fixtures','testing'].includes(entry.name)) await assets(source); }
    else if ((/\.(?:mjs|onnx|br|json)$/.test(entry.name) || entry.name === 'LICENSE')) { await mkdir(`dist/${directory}`, { recursive: true }); await cp(source, `dist/${source}`); }
  }
}
for (const directory of ['carriers','providers','places','core/transport']) await assets(directory);
await mkdir('dist/server', { recursive: true });
await cp('server/openapi.json', 'dist/server/openapi.json');
await cp('scripts/canary-report.mjs', 'dist/scripts/canary-report.mjs');
await chmod('dist/cli/index.js', 0o755);
