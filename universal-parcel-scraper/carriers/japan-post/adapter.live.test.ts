import { describe, expect, it } from 'vitest';
import { countryTimeZone } from '../../core/time/index.js';
import { JapanPostTracker } from './adapter.js';

describe('Japan Post live compatibility', () => {
  it.skipIf(!process.env.JAPAN_POST_TRACKING_NUMBER)('returns identity-bound history without browser state', async () => {
    const result = await new JapanPostTracker().fetch(process.env.JAPAN_POST_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.local_time && event.description)).toBe(true);
    // An instant is the wall clock on the row's own clock, never more than 14 hours away from it.
    expect(result.events?.every((event) => event.time === undefined
      || (/Z$/.test(event.time) && Math.abs(Date.parse(event.time) - Date.parse(`${String(event.local_time)}Z`)) <= 14 * 3_600_000))).toBe(true);
    // A clocked scan in a country with one zone (bar Spain, Portugal and France) is dated.
    const latest = result.events![0]!;
    const country = latest.location?.split(', ').pop() ?? '';
    if (countryTimeZone(country) && !['SPAIN', 'PORTUGAL', 'FRANCE'].includes(country) && String(latest.local_time).includes('T')) {
      expect(latest.time).toEqual(expect.any(String));
    }
    expect(result.last_update ?? null).toBe(result.events?.[0]!.time ?? null);
    expect(result.last_update_local).toEqual(expect.any(String));
  });

  it('recognizes the official synthetic unknown-item result', async () => {
    await expect(new JapanPostTracker().fetch('CN000000005JP')).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });
});
