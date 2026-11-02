import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { EUROPOCHTA_API, EuropochtaTracker } from './adapter.js';

const valid = (result: Awaited<ReturnType<EuropochtaTracker['fetch']>>) => {
  expect(result.events!.length).toBeGreaterThan(0);
  expect(result.events!.every(event => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time ?? ''))).toBe(true);
};
describe('Europochta native retrieval', () => {
  it.skipIf(!process.env.EUROPOCHTA_TRACKING_NUMBER)('reads native history without universal providers', async () => {
    const answer = await createTracker({ providers: [] }).track({ carrier: 'europochta', number: process.env.EUROPOCHTA_TRACKING_NUMBER! });
    expect(answer).toMatchObject({ carrier: 'europochta', source: 'europochta', attempts: [{ source: 'europochta', kind: 'ok' }] });
    valid(answer.result);
  }, 30_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.EUROPOCHTA_TRACKING_NUMBER)('recovers an induced direct challenge through the real browser service', async () => {
    const fetcher: typeof fetch = (url, init) => String(url).startsWith(EUROPOCHTA_API)
      ? Promise.resolve(new Response('Blocked', { status: 403 })) : fetch(url, init);
    const result = await new EuropochtaTracker({ fetcher, trawl: TrawlClient.fromEnvironment() }).fetch(process.env.EUROPOCHTA_TRACKING_NUMBER!);
    valid(result);
  }, 60_000);
});
