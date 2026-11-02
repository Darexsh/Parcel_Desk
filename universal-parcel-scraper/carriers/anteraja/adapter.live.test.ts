import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const make = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
describe('Anteraja live guest tracking', () => {
  it.skipIf(!process.env.ANTERAJA_TRACKING_NUMBER)('retrieves matching shipment activity without a CAPTCHA or account', async () => {
    const number = process.env.ANTERAJA_TRACKING_NUMBER!;
    const result = await make().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(row => row.local_time)).toBe(true);
    await expect(make().recognize!(number)).resolves.toMatchObject({ known: true });
  });
  it.skipIf(!process.env.ANTERAJA_UNKNOWN_NUMBER)('distinguishes an explicit unknown waybill', async () => {
    await expect(make().track({ number: process.env.ANTERAJA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
