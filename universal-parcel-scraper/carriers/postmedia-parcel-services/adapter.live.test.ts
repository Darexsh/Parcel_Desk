import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.POSTMEDIA_PARCEL_SERVICES_TRACKING_NUMBER;
const postcode = process.env.POSTMEDIA_PARCEL_SERVICES_POSTCODE;
// Z starts no Canadian postal code, so an unknown number can be asked without a real one.
const unknownPostcode = postcode ?? 'Z9Z 9Z9';

describe('Postmedia Parcel Services live retrieval', () => {
  it.skipIf(!number || !postcode)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'postmedia-parcel-services', postcode: postcode! });
    expect(answer).toMatchObject({ carrier: 'postmedia-parcel-services', source: 'postmedia-parcel-services' });
    expect(answer.attempts[0]).toMatchObject({ source: 'postmedia-parcel-services', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in GMT.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.POSTMEDIA_PARCEL_SERVICES_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POSTMEDIA_PARCEL_SERVICES_UNKNOWN_NUMBER!, postcode: unknownPostcode }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
