import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Veloces live retrieval', () => {
  it.skipIf(!process.env.VELOCES_TRACKING_NUMBER)('retrieves the history of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VELOCES_TRACKING_NUMBER!, carrier: 'veloces' });
    expect(answer).toMatchObject({ carrier: 'veloces', source: 'veloces' });
    expect(answer.attempts[0]).toMatchObject({ source: 'veloces', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps its instant in UTC, its id and its name.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.VELOCES_UNKNOWN_NUMBER)('reads an unknown guide as not found', async () => {
    await expect(direct().track({ number: process.env.VELOCES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
