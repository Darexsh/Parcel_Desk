import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const NAMES = /Signing for|Consignee|Fwd No/i;

describe('Atlantic International Express live retrieval', () => {
  it.skipIf(!process.env.ATLANTIC_COURIER_TRACKING_NUMBER)('retrieves dated history for the requested air waybill with providers disabled', async () => {
    const number = process.env.ATLANTIC_COURIER_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'atlantic-courier' });
    expect(answer).toMatchObject({ carrier: 'atlantic-courier', source: 'atlantic-courier', attempts: [{ source: 'atlantic-courier', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.local_time || event.time) && event.description)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(NAMES);
  }, 45_000);

  it.skipIf(!process.env.ATLANTIC_COURIER_DELIVERED_NUMBER)('settles a delivered air waybill from its summary and scans', async () => {
    const result = await direct().track({ number: process.env.ATLANTIC_COURIER_DELIVERED_NUMBER! });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect((result.events ?? []).some(event => event.time?.endsWith('+05:30'))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ATLANTIC_COURIER_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown air waybill as not found', async () => {
    await expect(direct().track({ number: process.env.ATLANTIC_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
