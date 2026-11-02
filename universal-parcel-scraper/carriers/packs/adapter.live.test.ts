import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const postcode = process.env.PACKS_POSTCODE;

describe('Packs live retrieval', () => {
  it.skipIf(!process.env.PACKS_TRACKING_NUMBER || !postcode)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.PACKS_TRACKING_NUMBER!, carrier: 'packs', postcode: postcode! });
    expect(answer).toMatchObject({ carrier: 'packs', source: 'packs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'packs', kind: 'ok' });
    expect(answer.result.last_status_text).toBeTruthy();
    // Every status is dated in Dutch time.
    expect(answer.result.events.every((event) => event.description && /[+-]0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PACKS_UNKNOWN_NUMBER || !postcode)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PACKS_UNKNOWN_NUMBER!, postcode })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
