import { describe, expect, it } from 'vitest';
import { adapter, speeDeeUnanswered } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER,
  trawl: TrawlClient.fromEnvironment(), browserExecutablePath: null });

describe('Spee-Dee live package progress', () => {
  it('answers a well-formed unknown barcode with a clean not-found', async (context) => {
    const error: unknown = await instance().track({ number: 'SP999999999999999917' }).then(() => undefined, caught => caught);
    // The host drops connections from many networks while others get the
    // answer: a dropped or refused connection, or no reply at all, proves
    // neither breakage nor health. A failed name lookup, a bad certificate, a
    // reply that breaks or stalls, or a missing page still fails.
    if (speeDeeUnanswered(error)) {
      return context.skip('Spee-Dee did not answer this network: adapter remains unverified');
    }
    expect(error).toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.SPEE_DEE_TRACKING_NUMBER)('reads a real barcode as wall clocks without recipient details', async () => {
    const result = await instance().track({ number: process.env.SPEE_DEE_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Signed by|Delivered to|=>|\(\d+\)/);
  });
});
