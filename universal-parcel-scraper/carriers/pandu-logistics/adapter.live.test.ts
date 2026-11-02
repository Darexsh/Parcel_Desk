import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pandu Logistics live retrieval', () => {
  it.skipIf(!process.env.PANDU_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PANDU_LOGISTICS_TRACKING_NUMBER!, carrier: 'pandu-logistics' });
    expect(answer).toMatchObject({ carrier: 'pandu-logistics', source: 'pandu-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pandu-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its branch's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => !/\bRECEIVED BY\b/i.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PANDU_LOGISTICS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.PANDU_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PANDU_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PANDU_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
