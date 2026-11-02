import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SkyNet Worldwide Express live retrieval', () => {
  it.skipIf(!process.env.SKYNET_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SKYNET_WORLDWIDE_TRACKING_NUMBER!, carrier: 'skynet-worldwide' });
    expect(answer).toMatchObject({ carrier: 'skynet-worldwide', source: 'skynet-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'skynet-worldwide', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and its event number, and either an offset or a wall clock to the minute.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && (event.time ? /[+-]\d{2}:\d{2}$/.test(event.time) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SKYNET_WORLDWIDE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SKYNET_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
