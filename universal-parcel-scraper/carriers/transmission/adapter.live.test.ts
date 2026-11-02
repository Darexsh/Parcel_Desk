import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.TRANSMISSION_TRACKING_NUMBER;
const postcode = process.env.TRANSMISSION_POSTCODE;
// A postcode the shipment is not filed under.
const other = postcode?.replace(/\s+/g, '').toUpperCase() === '1000AA' ? '9999ZZ' : '1000AA';

describe('TransMission live retrieval', () => {
  it.skipIf(!number || !postcode)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'transmission', postcode: postcode! });
    expect(answer).toMatchObject({ carrier: 'transmission', source: 'transmission' });
    expect(answer.attempts[0]).toMatchObject({ source: 'transmission', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated in Dutch time.
    expect(answer.result.events.every((event) => event.description && /[+-]0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!number || !postcode)('asks for the postcode again when the shipment is not filed under the one given', async () => {
    await expect(direct().track({ number: number!, postcode: other }))
      .rejects.toMatchObject({ kind: 'input_required', field: 'postcode', reason: 'postcode_mismatch' });
  }, 45_000);

  it.skipIf(!process.env.TRANSMISSION_UNKNOWN_NUMBER || !postcode)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TRANSMISSION_UNKNOWN_NUMBER!, postcode })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
