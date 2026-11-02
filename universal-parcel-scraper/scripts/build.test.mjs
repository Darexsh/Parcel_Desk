import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Run the real build orchestration; stand-ins isolate version/asset handling
// from TypeScript and Vite, which have their own package checks.
test('build derives source and shipped OpenAPI versions from the manifest, including prereleases', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'parcel-build-'));
  const consumer = path.join(root, 'consumer');
  mkdirSync(path.join(consumer, 'dist'), { recursive: true });
  writeFileSync(path.join(consumer, 'dist/keep.txt'), 'Unrelated build');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'server', 'carriers', 'providers', 'places', 'core/transport', 'bin']) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  copyFileSync(new URL('./build.mjs', import.meta.url), path.join(root, 'scripts/build.mjs'));
  writeFileSync(path.join(root, 'scripts/canary-report.mjs'), 'export {};\n');
  for (const [name, source] of [
    ['tsc', "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist/cli',{recursive:true});writeFileSync('dist/cli/index.js','');"],
    ['vite', ''],
  ]) {
    const binary = path.join(root, 'bin', name);
    if (process.platform === 'win32') {
      writeFileSync(binary + '.mjs', source);
      writeFileSync(binary + '.cmd', `@"${process.execPath}" "%~dp0${name}.mjs"\r\n`);
    } else {
      writeFileSync(binary, `#!${process.execPath}\n${source}\n`);
      chmodSync(binary, 0o755);
    }
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }));
  const document = { openapi: '3.0.3', info: { title: 'Synthetic API', version: '0.0.0', description: 'Keep this description' },
    paths: { '/synthetic': { get: { responses: { 200: { description: 'Synthetic response' } } } } } };
  writeFileSync(path.join(root, 'server/openapi.json'), JSON.stringify(document, null, 2) + '\n');
  for (const version of ['1.2.3', '1.2.4-main.17']) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version }));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: consumer, encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(path.join(consumer, 'dist/keep.txt'), 'utf8'), 'Unrelated build');
    const expected = { ...document, info: { ...document.info, version } };
    for (const file of ['server/openapi.json', 'dist/server/openapi.json']) {
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, file), 'utf8')), expected, file);
    }
  }
  // Release builds first, then npm assigns the final prerelease version.
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.4-main.17',
    scripts: { build: scripts.build, version: scripts.version } }));
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['version', '1.2.5-main.18', '--no-git-tag-version', '--ignore-scripts=false'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of ['server/openapi.json', 'dist/server/openapi.json']) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, file), 'utf8')),
      { ...document, info: { ...document.info, version: '1.2.5-main.18' } }, file);
  }
});
