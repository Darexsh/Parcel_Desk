import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CityMail live retrieval', () => {
  it.skipIf(!process.env.CITYMAIL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.CITYMAIL_TRACKING_NUMBER!, carrier: 'citymail' });
    expect(answer).toMatchObject({ carrier: 'citymail', source: 'citymail' });
    expect(answer.attempts[0]).toMatchObject({ source: 'citymail', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan's clock reads as Stockholm time, and the delivery town loses its postcode.
    expect(answer.result.events.every((event) => event.description && /T\d{2}:\d{2}:00\+0[12]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => /^\d{3} ?\d{2} /.test(String(event.location ?? '')))).toBe(false);
  }, 60_000);

  it.skipIf(!process.env.CITYMAIL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.CITYMAIL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CITYMAIL_UNKNOWN_NUMBER)('reads an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.CITYMAIL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
