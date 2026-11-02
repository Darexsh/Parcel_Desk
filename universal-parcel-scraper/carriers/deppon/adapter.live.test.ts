import { describe, expect, it } from 'vitest';
import { DepponTracker } from './adapter.js';

const number = process.env.DEPPON_TRACKING_NUMBER;
const unknown = process.env.DEPPON_UNKNOWN_NUMBER;
describe('Deppon live tracking', () => {
  it.skipIf(!number)('reads history after accepted slider verification', async () => {
    const result = await new DepponTracker().fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_status_text).toEqual(expect.any(String));
  }, 40_000);
  it.skipIf(!unknown)('confirms an unknown waybill after verification', async () => {
    await expect(new DepponTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 40_000);
});
