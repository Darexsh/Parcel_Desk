import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CJ Logistics live retrieval', () => {
  it.skipIf(!process.env.CJ_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CJ_LOGISTICS_TRACKING_NUMBER!, carrier: 'cj-logistics' });
    expect(answer).toMatchObject({ carrier: 'cj-logistics', source: 'cj-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cj-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read on Korean time, to the second.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CJ_LOGISTICS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.CJ_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CJ_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CJ_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
