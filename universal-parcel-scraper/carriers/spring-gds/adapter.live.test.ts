import { describe, expect, it } from 'vitest';
import { AdapterRegistry, REGISTRY, UniversalTracker, trackCarrier } from '../../node.js';
import { RateLimitedError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fetchPostNL } from './adapter.js';

// A validly shaped Dutch S10 number that was never issued: PostNL answers with
// an item that has no events and says the barcode was not found.
const POSTNL_WRONG_NUMBER = 'LT000000000NL';
// A 3S barcode in the layout the endpoint reads that PostNL never issued: the item
// says the barcode was incorrect, or not found, which may mean a parcel sent within the
// Netherlands that only the domestic tracker shows with its postcode.
const POSTNL_FOREIGN_BARCODE = '3SQZQZ123456789';
// The endpoint calls every thirteen-character 3S barcode incorrect, PostNL's own included.
const POSTNL_SHORT_BARCODE = '3SQZQZ1234567';
// A private parcel, as a consumer stored it, and for a 3S parcel sent within the
// Netherlands its delivery postcode (see this folder's README).
const number = (process.env.SPRING_GDS_TRACKING_NUMBER ?? '').trim();
const postcode = (process.env.SPRING_GDS_POSTCODE ?? '').trim();

describe('PostNL live tracking', () => {
  it('maps the official barcode-not-found result to a clean 404', async (context) => {
    const answer = fetchPostNL(POSTNL_WRONG_NUMBER);
    // PostNL's token endpoint rate-limits a shared runner's address; the adapter reports that as it is.
    const limited = await answer.then(() => null, (error: unknown) => error instanceof RateLimitedError && error.status === 429 ? error : null);
    if (limited) return context.skip('PostNL answered HTTP 429 to this network: the not-found mapping remains unverified');
    await expect(answer).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      message: 'PostNL could not locate the shipment',
    });
  });

  it('maps a 3S barcode PostNL did not issue to not found, or asks its postcode', async (context) => {
    const answer = fetchPostNL(POSTNL_FOREIGN_BARCODE);
    const limited = await answer.then(() => null, (error: unknown) => error instanceof RateLimitedError && error.status === 429 ? error : null);
    if (limited) return context.skip('PostNL answered HTTP 429 to this network: the not-found mapping remains unverified');
    await expect(answer).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:not_found|input_required)$/) });
  });

  it('leaves a thirteen-character 3S barcode inconclusive', async (context) => {
    const answer = fetchPostNL(POSTNL_SHORT_BARCODE);
    const limited = await answer.then(() => null, (error: unknown) => error instanceof RateLimitedError && error.status === 429 ? error : null);
    if (limited) return context.skip('PostNL answered HTTP 429 to this network: the incorrect-barcode reading remains unverified');
    await expect(answer).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.runIf(Boolean(number))('returns the history of a parcel dispatched through a consumer router', async () => {
    const environment = { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER };
    const result = await trackCarrier('spring-gds', { number, ...(postcode ? { postcode } : {}) }, {
      registry: new AdapterRegistry(REGISTRY, environment), universal: new UniversalTracker({ environment, providers: [] }),
    });
    expect(result.events?.length).toBeGreaterThan(0);
  });
});
