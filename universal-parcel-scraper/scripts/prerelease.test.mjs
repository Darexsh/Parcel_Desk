import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPublishedFrom, awaitVersion, baseVersion, compareTrees, compareVersions, entryPoints, laterPrerelease, newestVersion,
  parseVersion, planPrerelease, planStable, prereleaseVersion, readTree, report, settlePlan,
} from './prerelease.mjs';

const tree = (files) => new Map(Object.entries(files).map(([file, text]) => [file, Buffer.from(text)]));
const manifest = (fields) => JSON.stringify({ name: 'example', version: '1.0.0', ...fields }, null, 2);

test('parses versions and rejects what is not semver', () => {
  assert.deepEqual(parseVersion('0.2.1-main.284'), { core: [0, 2, 1], prerelease: ['main', '284'] });
  assert.deepEqual(parseVersion('1.2.3+build.5'), { core: [1, 2, 3], prerelease: [] });
  for (const invalid of ['1.2', 'v1.2.3', '1.2.3-', '1.2.3-a..b', 'latest', '']) assert.equal(parseVersion(invalid), undefined);
});

test('orders versions by semver precedence', () => {
  const ascending = [
    '0.0.0-stage', '0.2.0', '0.2.1-main.9', '0.2.1-main.10', '0.2.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0',
  ];
  for (let index = 1; index < ascending.length; index += 1) {
    assert.equal(compareVersions(ascending[index - 1], ascending[index]), -1, `${ascending[index - 1]} < ${ascending[index]}`);
    assert.equal(compareVersions(ascending[index], ascending[index - 1]), 1);
  }
  assert.deepEqual([...ascending].reverse().sort(compareVersions), ascending);
});

test('ranks numeric prerelease identifiers below alphanumeric ones and compares them as numbers', () => {
  assert.equal(compareVersions('1.0.0-main.2', '1.0.0-main.10'), -1);
  assert.equal(compareVersions('1.0.0-99', '1.0.0-main'), -1);
  assert.equal(compareVersions('1.0.0-main.99', '1.0.0-main.x'), -1);
  assert.equal(compareVersions('1.0.0-main.1', '1.0.0-main.1.0'), -1);
  assert.equal(compareVersions('1.0.0-main.5+a', '1.0.0-main.5+b'), 0);
  assert.throws(() => compareVersions('1.0.0', 'next'), /Not a semver version: next/);
});

test('finds the newest published version, prereleases included', () => {
  assert.equal(newestVersion([]), undefined);
  assert.equal(newestVersion(['0.0.0-stage']), '0.0.0-stage');
  assert.equal(newestVersion(['0.0.0-stage', '0.2.0']), '0.2.0');
  assert.equal(newestVersion(['0.2.1-main.10', '0.2.0', '0.2.1-main.9', 'not-a-version']), '0.2.1-main.10');
  assert.equal(newestVersion(['0.3.0-main.300', '0.3.0']), '0.3.0');
});

test('keeps the package.json version until it is released, then moves to the next patch', () => {
  assert.equal(baseVersion('0.2.0', ['0.0.0-stage', '0.2.0']), '0.2.1');
  assert.equal(baseVersion('0.3.0', ['0.0.0-stage', '0.2.0', '0.2.1-main.280']), '0.3.0');
  assert.equal(baseVersion('0.3.0', ['0.2.0', '0.3.0-main.290']), '0.3.0');
  assert.equal(baseVersion('0.0.0', ['0.0.0-stage']), '0.0.0');
  assert.equal(baseVersion('0.2.0', []), '0.2.0');
  assert.equal(baseVersion('1.0.0-rc.1', ['1.0.0']), '1.0.1');
  assert.throws(() => baseVersion('next', []), /not semver/);
  assert.equal(prereleaseVersion('0.2.0', ['0.2.0'], 284), '0.2.1-main.284');
  assert.equal(prereleaseVersion('0.3.0', ['0.2.0'], 284), '0.3.0-main.284');
});

test('spots a prerelease published from a later commit', () => {
  assert.equal(laterPrerelease(['0.2.0', '0.2.1-main.284', '0.2.1-main.290'], 284), '0.2.1-main.290');
  assert.equal(laterPrerelease(['0.0.0-stage', '0.2.0', '0.2.1-main.284'], 284), undefined);
  assert.equal(laterPrerelease(['0.2.1-main.284.1', '0.2.1-domain.999'], 1), undefined);
});

test('compares with the newest published version when HEAD is ahead of it', () => {
  assert.deepEqual(planPrerelease('0.2.0', ['0.0.0-stage', '0.2.0'], 284), { version: '0.2.1-main.284', published: false, baseline: '0.2.0' });
  assert.deepEqual(planPrerelease('0.2.0', ['0.2.0', '0.2.1-main.284'], 285), { version: '0.2.1-main.285', published: false, baseline: '0.2.1-main.284' });
  assert.deepEqual(planPrerelease('0.3.0', ['0.2.0', '0.2.1-main.284'], 285), { version: '0.3.0-main.285', published: false, baseline: '0.2.1-main.284' });
});

test('publishes without a comparison when nothing is published', () => {
  assert.deepEqual(planPrerelease('0.2.0', [], 284), {
    version: '0.2.0-main.284', publish: true, published: false, notify: true, reason: 'nothing is published yet',
  });
});

test('announces a version that is already published without publishing it again', () => {
  assert.deepEqual(planPrerelease('0.2.0', ['0.2.0', '0.2.1-main.284'], 284), {
    version: '0.2.1-main.284', publish: false, published: true, notify: true, reason: 'already on npm',
  });
});

test('refuses a published version that was built from another commit', () => {
  const head = 'a'.repeat(40);
  assert.doesNotThrow(() => assertPublishedFrom('0.2.1-main.284', head, head));
  assert.doesNotThrow(() => assertPublishedFrom('0.2.1-main.284', undefined, head));
  assert.throws(
    () => assertPublishedFrom('0.2.1-main.284', 'b'.repeat(40), head),
    /^Error: 0\.2\.1-main\.284 is already on npm from commit bbbbbbb, and HEAD is aaaaaaa\. Push another commit to release it\.$/,
  );
});

test('neither publishes nor announces a commit that a newer version supersedes', () => {
  assert.deepEqual(planPrerelease('0.2.0', ['0.2.0', '0.2.1-main.284', '0.2.1-main.290'], 284), {
    version: '0.2.1-main.284', publish: false, published: true, notify: false, reason: '0.2.1-main.290 is newer',
  });
  assert.deepEqual(planPrerelease('0.2.0', ['0.2.0', '0.2.1-main.290'], 287), {
    version: '0.2.1-main.287', publish: false, published: false, notify: false, reason: '0.2.1-main.290 is newer',
  });
  // A stable release from a later commit overtook this one.
  assert.deepEqual(planPrerelease('0.2.0', ['0.2.0', '0.3.0'], 284), {
    version: '0.2.1-main.284', publish: false, published: false, notify: false, reason: '0.3.0 is newer',
  });
  // The base moved on after a stable release, but a later commit is already out.
  assert.equal(planPrerelease('0.3.0', ['0.3.0-main.286', '0.3.0'], 284).reason, '0.3.0-main.286 is newer');
});

test('publishes only a package that differs from the baseline, or one it cannot compare', (t) => {
  const plan = { version: '0.2.1-main.285', published: false, baseline: '0.2.1-main.284' };
  assert.deepEqual(settlePlan(plan, () => []), {
    version: '0.2.1-main.285', publish: false, published: false, notify: false, reason: 'the package is identical to 0.2.1-main.284',
  });
  assert.deepEqual(settlePlan(plan, () => ['dist/index.js']), {
    version: '0.2.1-main.285', publish: true, published: false, notify: true, reason: '1 file (dist/index.js) differs from 0.2.1-main.284',
  });
  assert.equal(settlePlan(plan, () => ['a', 'b', 'c', 'd']).reason, '4 files (a, b, c, …) differ from 0.2.1-main.284');
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(settlePlan(plan, () => { throw new Error('Command failed: npm pack'); }), {
    version: '0.2.1-main.285', publish: true, published: false, notify: true, reason: 'could not compare with 0.2.1-main.284',
  });
  assert.deepEqual(console.error.mock.calls.map((call) => call.arguments), [['Command failed: npm pack']]);
});

test('waits until npm lists a version', async (t) => {
  const pauses = [];
  const pause = async (ms) => { pauses.push(ms); };
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  await awaitVersion('0.2.1-main.285', () => ['0.2.0', '0.2.1-main.285'], { pause });
  assert.deepEqual(pauses, []);
  assert.equal(console.log.mock.callCount(), 0);

  const answers = [
    () => ['0.2.0'],
    () => { throw new Error('Command failed: npm view\nnpm error network'); },
    () => ['0.2.0', '0.2.1-main.285'],
  ];
  await awaitVersion('0.2.1-main.285', () => answers.shift()(), { attempts: 5, pauseMs: 15_000, pause });
  assert.deepEqual(pauses, [15_000, 15_000]);
  assert.deepEqual(console.log.mock.calls.map((call) => call.arguments), [['Waiting for npm to list 0.2.1-main.285.']]);
  assert.deepEqual(console.error.mock.calls.map((call) => call.arguments), [['Command failed: npm view']]);

  pauses.length = 0;
  await assert.rejects(
    awaitVersion('0.2.1-main.286', () => ['0.2.0', '0.2.1-main.285'], { attempts: 3, pauseMs: 1, pause }),
    /^Error: npm still does not list 0\.2\.1-main\.286\. Rerun this job once it does\.$/,
  );
  assert.deepEqual(pauses, [1, 1]);
});

test('plans a stable release once, and never behind a published prerelease', () => {
  assert.deepEqual(planStable('0.3.0', ['0.2.0', '0.3.0-main.290'], 290), {
    version: '0.3.0', publish: true, published: false, notify: true, reason: 'not on npm yet',
  });
  assert.deepEqual(planStable('0.3.0', ['0.2.0', '0.3.0-main.290', '0.3.0'], 290), {
    version: '0.3.0', publish: false, published: true, notify: true, reason: 'already on npm',
  });
  assert.equal(planStable('0.3.0', ['0.3.0', '0.3.1-main.291'], 290).notify, false);
  assert.throws(() => planStable('0.3.0', ['0.2.0', '0.3.0-main.291'], 290), /0\.3\.0-main\.291 is already published from a later commit/);
  assert.throws(() => planStable('0.3.0-rc.1', [], 290), /X\.Y\.Z/);
});

test('treats packages that differ only by README, version and devDependencies as identical', () => {
  const baseline = tree({ 'package.json': manifest({ version: '0.2.1-main.284' }), 'README.md': 'old', 'dist/index.js': 'export {};' });
  const fresh = tree({ 'package.json': manifest({ version: '0.2.0' }).replace(/\n/g, '\r\n'), 'README.md': 'new', 'dist/index.js': 'export {};' });
  assert.deepEqual(compareTrees(fresh, baseline), []);
  assert.deepEqual(compareTrees(tree({}), tree({})), []);
  const tooling = (vitest) => tree({ 'package.json': manifest({ dependencies: { luxon: '^3.7.2' }, devDependencies: { vitest } }) });
  assert.deepEqual(compareTrees(tooling('^5.0.3'), tooling('^5.0.2')), []);
  assert.deepEqual(compareTrees(tooling('^5.0.3'), tree({ 'package.json': manifest({ dependencies: { luxon: '^3.7.2' } }) })), []);
});

test('reports added, removed and changed files', () => {
  const baseline = tree({ 'package.json': manifest({}), 'dist/index.js': 'a', 'dist/gone.js': 'a', 'data/catalog.json': '[]' });
  const fresh = tree({ 'package.json': manifest({}), 'dist/index.js': 'b', 'dist/new.js': 'a', 'data/catalog.json': '[]' });
  assert.deepEqual(compareTrees(fresh, baseline), ['dist/gone.js', 'dist/index.js', 'dist/new.js']);
});

test('reports a package.json change other than the version, and a nested README', () => {
  const baseline = tree({ 'package.json': manifest({ dependencies: { luxon: '^3.7.2' } }), 'dist/README.md': 'a' });
  assert.deepEqual(compareTrees(tree({ 'package.json': manifest({ dependencies: { luxon: '^3.8.0' } }), 'dist/README.md': 'a' }), baseline), ['package.json']);
  assert.deepEqual(compareTrees(tree({ 'package.json': manifest({ dependencies: { luxon: '^3.7.2' } }), 'dist/README.md': 'b' }), baseline), ['dist/README.md']);
  assert.deepEqual(compareTrees(tree({ 'package.json': '{' }), tree({ 'package.json': '{ ' })), ['package.json']);
});

test('reads a packed tree with forward-slash paths', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prerelease-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'dist', 'cli', 'index.js'), 'cli');
  const files = readTree(directory);
  assert.deepEqual([...files.keys()].sort(), ['dist/cli/index.js', 'package.json']);
  assert.equal(files.get('dist/cli/index.js').toString(), 'cli');
});

test('lists the files package.json promises', () => {
  assert.deepEqual(entryPoints({
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './data/*': './data/*' },
    bin: { tool: 'dist/cli/index.js' },
  }), ['dist/index.d.ts', 'dist/index.js', 'dist/cli/index.js']);
  assert.deepEqual(entryPoints({ exports: './index.js', bin: './cli.js' }), ['index.js', 'cli.js']);
  assert.deepEqual(entryPoints({}), []);
});

test('writes the plan as step outputs and one summary line', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prerelease-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') };
  t.mock.method(console, 'log', () => {});
  report({ version: '0.2.1-main.284', publish: true, published: false, notify: true, reason: '2 files (a,\n b) differ from 0.2.0' }, env);
  assert.equal(
    fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    'version=0.2.1-main.284\npublish=true\npublished=false\nnotify=true\nreason=2 files (a, b) differ from 0.2.0\n',
  );
  assert.equal(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), 'Publish `0.2.1-main.284`: 2 files (a, b) differ from 0.2.0.\n');
  report({ version: '0.2.1-main.285', publish: false, published: false, notify: false, reason: 'the package is identical to 0.2.1-main.284' }, {});
  assert.equal(console.log.mock.calls.at(-1).arguments[0].split('\n')[0], 'Skip `0.2.1-main.285`: the package is identical to 0.2.1-main.284.');
});
