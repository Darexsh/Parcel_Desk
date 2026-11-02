import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const postcode = process.env.RELAYTECH_POSTCODE;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Relay live retrieval', () => {
  it.skipIf(!process.env.RELAYTECH_TRACKING_NUMBER || !postcode)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.RELAYTECH_TRACKING_NUMBER!, carrier: 'relaytech', postcode });
    expect(answer).toMatchObject({ carrier: 'relaytech', source: 'relaytech' });
    expect(answer.attempts[0]).toMatchObject({ source: 'relaytech', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time) && event.provider_code)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.RELAYTECH_UNKNOWN_NUMBER || !postcode)('reads an unknown ID as inconclusive, as a wrong postcode is', async () => {
    await expect(direct().track({ number: process.env.RELAYTECH_UNKNOWN_NUMBER!, postcode }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 30_000);
});
