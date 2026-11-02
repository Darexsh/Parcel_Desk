import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SkyKing live retrieval', () => {
  it.skipIf(!process.env.SKYKING_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SKYKING_TRACKING_NUMBER!, carrier: 'skyking' });
    expect(answer).toMatchObject({ carrier: 'skyking', source: 'skyking' });
    expect(answer.attempts[0]).toMatchObject({ source: 'skyking', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Indian time and kept as an instant.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
    // The details listed after a wording, such as the courier's name, are dropped.
    expect(answer.result.events.every((event) => !/Delivery Boy|Area Name|Item No/i.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SKYKING_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.SKYKING_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.SKYKING_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SKYKING_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
