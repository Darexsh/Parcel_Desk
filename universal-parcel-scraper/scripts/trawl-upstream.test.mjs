import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { movePins, newestRelease, PINS, readPin } from './trawl-upstream.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const next = { version: '99.0.1', digest: `sha256:${'ab'.repeat(32)}`, commit: 'cd'.repeat(20) };

function upstream({ tag = `v${next.version}`, commit = next.commit, digest = next.digest, status = 200 } = {}) {
  const asked = [];
  const fetcher = async (url, { headers }) => {
    asked.push({ url, headers });
    const { host, pathname } = new URL(url);
    const reply = (body, extra = {}) => new Response(body, { status, headers: extra });
    if (pathname.endsWith('/releases/latest')) return reply(JSON.stringify({ tag_name: tag }));
    if (pathname.includes('/commits/')) return reply(`${commit}\n`);
    if (host === 'ghcr.io' && pathname === '/token') return reply(JSON.stringify({ token: 'anonymous' }));
    return reply('', digest ? { 'docker-content-digest': digest } : {});
  };
  return { asked, fetcher };
}

test('every place that names the pinned TRAWL release agrees on it', () => {
  const pin = readPin(read);
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(pin.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
});

test('moves every pin to another release and back without touching anything else', () => {
  const pinned = readPin(read);
  const moved = movePins(read, pinned, next);
  assert.deepEqual([...moved.keys()].sort(), [...new Set(PINS.map(({ file }) => file))].sort());
  const readMoved = (file) => moved.get(file) ?? read(file);
  assert.deepEqual(readPin(readMoved), next);
  for (const [file, text] of moved) {
    assert.ok(!text.includes(pinned.digest) && !text.includes(pinned.commit), file);
  }
  for (const [file, text] of movePins(readMoved, next, pinned)) assert.equal(text, read(file), file);
});

test('refuses to read pins that disagree', () => {
  const stale = (file) => (file === '.github/workflows/release.yml' ? read(file).replace(readPin(read).commit, 'ef'.repeat(20)) : read(file));
  assert.throws(() => readPin(stale), /release\.yml does not name TRAWL/);
  assert.throws(() => readPin((file) => (file === 'trawl/Dockerfile' ? 'FROM debian:13\n' : read(file))), /no longer pin a TRAWL release/);
});

test('reads the newest release with its commit and image digest', async () => {
  const { asked, fetcher } = upstream();
  assert.deepEqual(await newestRelease(fetcher, 'github-token'), next);
  assert.deepEqual(asked.map(({ url }) => url), [
    'https://api.github.com/repos/germondai/trawl/releases/latest',
    `https://api.github.com/repos/germondai/trawl/commits/v${next.version}`,
    'https://ghcr.io/token?scope=repository:germondai/trawl:pull',
    `https://ghcr.io/v2/germondai/trawl/manifests/${next.version}`,
  ]);
  // GitHub's token never reaches the registry.
  assert.deepEqual(asked.map(({ headers }) => headers.authorization), ['Bearer github-token', 'Bearer github-token', undefined, 'Bearer anonymous']);
});

test('rejects a release it cannot pin', async () => {
  await assert.rejects(newestRelease(upstream({ tag: 'v2.0.0-rc.1' }).fetcher), /not a plain version/);
  await assert.rejects(newestRelease(upstream({ commit: 'main' }).fetcher), /named no commit/);
  await assert.rejects(newestRelease(upstream({ digest: null }).fetcher), /has no image digest/);
  await assert.rejects(newestRelease(upstream({ status: 403 }).fetcher), /api\.github\.com answered 403/);
});
