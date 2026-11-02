import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Loomis Express live retrieval', () => {
  it.skipIf(!process.env.LOOMIS_EXPRESS_TRACKING_NUMBER)('retrieves dated history for the requested waybill with providers disabled', async () => {
    const number = process.env.LOOMIS_EXPRESS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number, carrier: 'loomis-express' });
    expect(answer).toMatchObject({ carrier: 'loomis-express', source: 'loomis-express', attempts: [{ source: 'loomis-express', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.LOOMIS_EXPRESS_UNKNOWN_NUMBER)('reads the not-available notice for an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.LOOMIS_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.LOOMIS_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
