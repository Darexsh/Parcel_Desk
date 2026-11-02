import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('APC Overnight live retrieval', () => {
  it.skipIf(!process.env.APC_OVERNIGHT_TRACKING_NUMBER)('retrieves dated history for the requested waybill with providers disabled', async () => {
    const number = process.env.APC_OVERNIGHT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number, carrier: 'apc-overnight' });
    expect(answer).toMatchObject({ carrier: 'apc-overnight', source: 'apc-overnight', attempts: [{ source: 'apc-overnight', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && !event.location)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.APC_OVERNIGHT_UNKNOWN_NUMBER)('reads the not-found notice for an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.APC_OVERNIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.APC_OVERNIGHT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
