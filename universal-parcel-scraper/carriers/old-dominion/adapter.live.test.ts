import { describe, expect, it } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

// TRACKING_CHROMIUM_PATH=/path/to/chromium OLD_DOMINION_TRACKING_NUMBER=<PRO> npm run test:carriers:live -- carriers/old-dominion
// Never commit the PRO, a reply or any field it returns.
const CHROMIUM = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const NUMBER = process.env.OLD_DOMINION_TRACKING_NUMBER?.trim() ?? '';
const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: CHROMIUM });
// The page's reCAPTCHA Enterprise score decides each lookup, and it scores
// some browsers and networks, GitHub runners included, too low: a challenge
// proves neither breakage nor health.
const REFUSED = 'Old Dominion\'s reCAPTCHA refused this browser: the trace page remains unverified';

describe('Old Dominion live trace page', () => {
  it.skipIf(!CHROMIUM)('answers a well-formed unknown PRO with a clean not-found', async (context) => {
    const error: unknown = await instance().track({ number: '07200000001' }, { budgetMs: 60_000 }).then(() => undefined, caught => caught);
    if (carrierErrorKind(error) === 'challenge') return context.skip(REFUSED);
    expect(error).toMatchObject({ kind: 'not_found' });
  }, 65_000);

  it.skipIf(!CHROMIUM || !NUMBER)('reads a real PRO on the offsets it states, without shipper or consignee details', async (context) => {
    let result: CarrierResult;
    try {
      result = await instance().track({ number: NUMBER }, { budgetMs: 60_000 });
    } catch (error) {
      if (carrierErrorKind(error) === 'challenge') return context.skip(REFUSED);
      throw error;
    }
    expect(result.status).not.toBe('unknown');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => /T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(event.time ?? ''))).toBe(true);
    for (const key of Object.keys(result)) {
      expect(['status', 'current_stage', 'current_stage_source', 'last_status_text', 'last_update', 'expected_delivery',
        'delivered_at', 'weight_kg', 'events', 'tracking_url', 'tracking_source']).toContain(key);
    }
    for (const event of result.events ?? []) {
      expect(Object.keys(event).every(key => ['time', 'location', 'description', 'provider_code', 'stage', 'stage_source'].includes(key))).toBe(true);
    }
  }, 65_000);
});
