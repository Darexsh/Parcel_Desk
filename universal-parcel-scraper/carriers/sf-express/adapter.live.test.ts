import { describe, expect, it } from 'vitest';
import { SfExpressTracker } from './adapter.js';
import { TrawlClient } from '../../core/transport/index.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.SF_EXPRESS_TRACKING_NUMBER;

describe('SF Express live public tracking', () => {
  it.skipIf(!trawl || !number)('returns matched dated history through the browser service', async () => {
    const result = await new SfExpressTracker({ trawl }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    const expectedCount = Number(process.env.SF_EXPRESS_EXPECTED_EVENTS);
    if (Number.isInteger(expectedCount) && expectedCount > 0) expect(result.events).toHaveLength(expectedCount);
    // Every scan reads on UTC+08:00, never ahead of the lookup; the newest is the last update.
    expect(result.events?.every((event) => !event.local_time && /\+08:00$/.test(String(event.time))
      && Date.parse(event.time!) <= Date.now())).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time);
    if (result.status === 'delivered' && result.events!.some((event) => event.stage === 'delivered')) {
      expect(result.delivered_at).toBe(result.events!.find((event) => event.stage === 'delivered')!.time);
    }
    expect(result.last_status_text).toEqual(expect.any(String));
  });

  it.skipIf(!trawl || process.env.SF_EXPRESS_CHECK_RESTRICTION !== '1')('preserves the observed synthetic-query restriction', async () => {
    await expect(new SfExpressTracker({ trawl }).fetch('SF0000000000000')).rejects.toMatchObject({ kind: 'challenge' });
  });
});
