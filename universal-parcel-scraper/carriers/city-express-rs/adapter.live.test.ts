import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('City Express live retrieval', () => {
  it.skipIf(!process.env.CITY_EXPRESS_RS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CITY_EXPRESS_RS_TRACKING_NUMBER!, carrier: 'city-express-rs' });
    expect(answer).toMatchObject({ carrier: 'city-express-rs', source: 'city-express-rs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'city-express-rs', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its depot's wall clock to the minute, read on Belgrade's clock.
    expect(answer.result.events.every((event) => event.description && event.location
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))
      && String(event.time).startsWith(String(event.local_time)) && /\+0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CITY_EXPRESS_RS_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.CITY_EXPRESS_RS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CITY_EXPRESS_RS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CITY_EXPRESS_RS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
