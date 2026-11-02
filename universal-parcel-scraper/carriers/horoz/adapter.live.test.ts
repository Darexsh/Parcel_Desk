import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Horoz Lojistik live retrieval', () => {
  it.skipIf(!process.env.HOROZ_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.HOROZ_TRACKING_NUMBER!, carrier: 'horoz' });
    expect(answer).toMatchObject({ carrier: 'horoz', source: 'horoz' });
    expect(answer.attempts[0]).toMatchObject({ source: 'horoz', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement keeps the page's wall clock to the second, without an offset, and a stage.
    expect(answer.result.events.every((event) => event.description && event.stage && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.HOROZ_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.HOROZ_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.HOROZ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HOROZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
