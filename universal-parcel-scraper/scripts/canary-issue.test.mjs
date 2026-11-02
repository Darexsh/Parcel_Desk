import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/carrier-canary.yml', import.meta.url), 'utf8');
const report = workflow.split('      - name: Open, update or close the canary issue\n')[1];
const script = report.split('        run: |\n')[1].trimEnd().split('\n')
  .map(line => line.replace(/^ {10}/, '')).join('\n');
const available = ['bash', 'jq'].every(command => spawnSync(command, ['--version']).status === 0);
const currentFailure = '- `Tracker > opens a tracking page`: current failure';
const previousFailure = '#### Rendered UI tracking links\n\n- `Tracker > opens a tracking page`: older failure';
const runUrl = 'https://github.com/example/carriers/actions/runs/100';

function runReport(t, { state = 'OPEN', previous = previousFailure, failed = true, cancelled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-issue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(path.join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  if (args[1].includes('/actions/runs/')) process.stdout.write(process.env.MOCK_CANCELLED === 'true' ? '123' : '');
  else if (args[1].includes('/annotations')) process.stdout.write('Cancelled by a user');
  else if (args.includes('repos/example/carriers/issues')) process.stdout.write(process.env.MOCK_STATE === 'NONE' ? '' : '12 ' + process.env.MOCK_STATE);
  else throw new Error('Unexpected mock API call');
} else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(process.env.MOCK_PREVIOUS);
else if (args[0] === 'issue') fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + '\\n');
else throw new Error('Unexpected mock command');
`, { mode: 0o755 });
  const needs = {
    gate: { result: 'success' }, probe: { result: 'skipped' }, adapters: { result: 'success' },
    'tracking-links': { result: cancelled ? 'cancelled' : failed ? 'failure' : 'success', outputs: { failures: currentFailure } },
    'search-pages': { result: 'skipped' },
  };
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH,
    GH_TOKEN: '', GITHUB_TOKEN: '', GH_REPO: 'example/carriers', NEEDS: JSON.stringify(needs), RUN_ID: '100', RUN_URL: runUrl,
    MOCK_STATE: state, MOCK_PREVIOUS: previous, MOCK_CALLS: calls, MOCK_CANCELLED: String(cancelled) };
  const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

function payload(call, flag = '--body') {
  assert.ok(call?.includes(flag), 'The issue write must carry its body');
  return call[call.indexOf(flag) + 1];
}

test('refreshes an unchanged failure in the body without adding a notification', { skip: !available }, t => {
  const calls = runReport(t);
  assert.deepEqual(calls.map(call => call[1]), ['edit']);
  assert.match(payload(calls[0]), /current failure/);
  assert.ok(payload(calls[0]).includes(runUrl));
  assert.doesNotMatch(payload(calls[0]), /older failure/);
});

test('refreshes a changed failure set and keeps its notification', { skip: !available }, t => {
  const calls = runReport(t, { previous: '- `Another tracker`: previous failure' });
  assert.deepEqual(calls.map(call => call[1]), ['edit', 'comment']);
  assert.equal(payload(calls[0]), payload(calls[1]));
});

test('replaces a closed issue body before reopening it', { skip: !available }, t => {
  const calls = runReport(t, { state: 'CLOSED' });
  assert.deepEqual(calls.map(call => call[1]), ['edit', 'reopen']);
  assert.equal(payload(calls[0]), payload(calls[1], '--comment'));
});

test('replaces stale failures with the passing run before closing', { skip: !available }, t => {
  const calls = runReport(t, { failed: false });
  assert.deepEqual(calls.map(call => call[1]), ['edit', 'close']);
  assert.equal(payload(calls[0]), 'All carrier canaries passed: ' + runUrl);
});

test('creates a first issue with the current failure body', { skip: !available }, t => {
  const calls = runReport(t, { state: 'NONE' });
  assert.deepEqual(calls.map(call => call[1]), ['create']);
  assert.match(payload(calls[0]), /current failure/);
});

test('does not change an issue after a manual cancellation', { skip: !available }, t => {
  assert.deepEqual(runReport(t, { cancelled: true }), []);
});
