import { describe, expect, it } from 'vitest';
import { AustraliaPostTracker } from './adapter.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.AUSTRALIA_POST_TRACKING_NUMBER;
const UNKNOWN = '7T0000000000000000000';
/** The browser tier alone: the direct request is refused before it leaves. */
const refused: typeof fetch = async () => new Response('', { status: 403 });

describe('Australia Post live direct compatibility', () => {
  it.skipIf(!number)('returns matched public history over plain HTTP', async () => {
    const result = await new AustraliaPostTracker({ trawl: null }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.time && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time))).toBe(true);
    expect(result.last_status_text).toEqual(expect.any(String));
  });

  it('recognizes a synthetic unknown reference', async (context) => {
    const error: unknown = await new AustraliaPostTracker({ trawl: null }).fetch(UNKNOWN).then(() => undefined, caught => caught);
    // Australia Post challenges some networks, GitHub runners included, while
    // others get the answer: a challenge proves neither breakage nor health.
    if (carrierErrorKind(error) === 'challenge') return context.skip('Australia Post challenged this network: direct tier remains unverified');
    expect(error).toMatchObject({ kind: 'not_found' });
  });
});

describe('Australia Post live browser compatibility', () => {
  it.skipIf(!trawl || !number)('returns matched public history through the browser service', async () => {
    const result = await new AustraliaPostTracker({ trawl, fetcher: refused }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.time && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time))).toBe(true);
    expect(result.last_status_text).toEqual(expect.any(String));
  });

  it.skipIf(!trawl)('recognizes a synthetic unknown reference', async () => {
    await expect(new AustraliaPostTracker({ trawl, fetcher: refused }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
