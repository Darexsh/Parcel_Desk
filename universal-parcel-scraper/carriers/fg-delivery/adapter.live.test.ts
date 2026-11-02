import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.FG_DELIVERY_TRACKING_NUMBER;

describe('FG Delivery live retrieval', () => {
  it.skipIf(!number)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'fg-delivery' });
    expect(answer).toMatchObject({ carrier: 'fg-delivery', source: 'fg-delivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fg-delivery', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset, and its code.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && /^\d+$/.test(String(event.provider_code)))).toBe(true);
  }, 45_000);

  it.skipIf(!number)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FG_DELIVERY_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FG_DELIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
