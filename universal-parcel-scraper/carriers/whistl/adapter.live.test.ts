import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Whistl live retrieval', () => {
  it.skipIf(!process.env.WHISTL_TRACKING_NUMBER)('retrieves dated history for the requested reference with providers disabled', async () => {
    const number = process.env.WHISTL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number, carrier: 'whistl' });
    expect(answer).toMatchObject({ carrier: 'whistl', source: 'whistl', attempts: [{ source: 'whistl', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.WHISTL_UNKNOWN_NUMBER)('reads the not-found heading for an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.WHISTL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.WHISTL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
