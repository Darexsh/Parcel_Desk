import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('RedX live retrieval', () => {
  it.skipIf(!process.env.REDX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.REDX_TRACKING_NUMBER!, carrier: 'redx' });
    expect(answer).toMatchObject({ carrier: 'redx', source: 'redx' });
    expect(answer.attempts[0]).toMatchObject({ source: 'redx', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan has its moment at Bangladesh's offset and an action, and names no phone number.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.stage
      && /\+06:00$/.test(String(event.time)) && Date.parse(String(event.time)) <= Date.now()
      && !/\d{9}/.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.REDX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.REDX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.REDX_UNKNOWN_NUMBER)('reads an unknown ID as not found', async () => {
    await expect(direct().track({ number: process.env.REDX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
