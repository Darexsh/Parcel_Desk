import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecaptchaAudioBackoff, createRedisAudioBackoffStore } from './recaptcha-backoff.mjs';

test('a block suppresses audio for six hours without extending the wait on another observation', () => {
  let now = 1000;
  const backoff = createRecaptchaAudioBackoff(() => now);
  assert.equal(backoff.remainingMs(), 0);
  backoff.block();
  now += 60_000;
  backoff.block();
  assert.equal(backoff.remainingMs(), 6 * 60 * 60 * 1000 - 60_000);
  now += 6 * 60 * 60 * 1000 - 60_000;
  assert.equal(backoff.remainingMs(), 0);
  backoff.block();
  assert.equal(backoff.remainingMs(), 6 * 60 * 60 * 1000);
});

test('a replacement process restores the original deadline and other processes see a shared block', async () => {
  let now = 1000, persisted = 0;
  const store = { load: async () => String(persisted), block: async (time, until) => {
    if (persisted <= time) persisted = until;
    return persisted;
  } };
  const original = createRecaptchaAudioBackoff(() => now, store);
  const another = createRecaptchaAudioBackoff(() => now, store);
  assert.equal(await another.remainingMs(), 0);
  await original.block();
  now += 3_600_000;
  const replacement = createRecaptchaAudioBackoff(() => now, store);
  assert.equal(await replacement.remainingMs(), 5 * 3_600_000);
  assert.equal(await another.remainingMs(), 5 * 3_600_000);
  await replacement.block();
  assert.equal(persisted, 1000 + 6 * 3_600_000);
  now = persisted;
  assert.equal(await replacement.remainingMs(), 0);
  await replacement.block();
  assert.equal(await original.remainingMs(), 6 * 3_600_000);
});

test('invalid, expired and implausibly distant stored deadlines never pause audio', async () => {
  for (const raw of [null, '', 'broken', 'NaN', -1, '1000', '20000000000000000', '21601001', 1.5, {}, []]) {
    const backoff = createRecaptchaAudioBackoff(() => 1000, { load: async () => raw });
    assert.equal(await backoff.remainingMs(), 0);
  }
});

test('an unavailable store keeps the local block; a stale read cannot erase it', async () => {
  let now = 1000, unavailable = 0;
  const backoff = createRecaptchaAudioBackoff(() => now, {
    load: async () => { throw new Error('unavailable'); }, block: async () => { throw new Error('unavailable'); },
  }, () => { unavailable++; });
  await backoff.block();
  now += 60_000;
  assert.equal(await backoff.remainingMs(), 6 * 3_600_000 - 60_000);
  assert.equal(unavailable, 2);
  let release;
  const stale = createRecaptchaAudioBackoff(() => now, {
    load: () => new Promise(resolve => { release = resolve; }), block: async (_, until) => until,
  });
  const reading = stale.remainingMs();
  await stale.block();
  release(null);
  assert.equal(await reading, 6 * 3_600_000);
});

test('a Redis timeout closes the connection and late connection setup cannot submit commands', async () => {
  let connect;
  const state = { closed: 0, commands: 0 };
  const client = { connect: () => new Promise(resolve => { connect = resolve; }),
    send: async () => { state.commands++; }, close: () => { state.closed++; } };
  const store = createRedisAudioBackoffStore({ createClient: async () => client, timeoutMs: 10 });
  await assert.rejects(store.load(), /deadline/);
  connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.commands, 0);
  assert.ok(state.closed > 0);
  let ready;
  const late = createRedisAudioBackoffStore({ createClient: () => new Promise(resolve => { ready = resolve; }), timeoutMs: 10 });
  await assert.rejects(late.load(), /deadline/);
  const before = state.closed;
  ready(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.closed > before);
  assert.equal(state.commands, 0);
});
