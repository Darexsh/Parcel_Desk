import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Nationex live retrieval', () => {
  it.skipIf(!process.env.NATIONEX_TRACKING_NUMBER)('retrieves the history of the requested shipment or parcel with providers disabled', async () => {
    const number = process.env.NATIONEX_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'nationex' });
    expect(answer).toMatchObject({ carrier: 'nationex', source: 'nationex', attempts: [{ source: 'nationex', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Wall clocks only: Nationex gives its scans no offset.
    expect(answer.result.events.every(event => event.local_time && event.time === undefined && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NATIONEX_UNKNOWN_NUMBER)('reads the service’s notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NATIONEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.NATIONEX_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
