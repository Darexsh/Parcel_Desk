import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Skroutz Last Mile live retrieval', () => {
  it.skipIf(!process.env.SKROUTZ_LAST_MILE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SKROUTZ_LAST_MILE_TRACKING_NUMBER!, carrier: 'skroutz-last-mile' });
    expect(answer).toMatchObject({ carrier: 'skroutz-last-mile', source: 'skroutz-last-mile' });
    expect(answer.attempts[0]).toMatchObject({ source: 'skroutz-last-mile', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan has its moment at Greece's offset, a tracking state and a stage, and names no coordinates.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.stage
      && /\+0[23]:00$/.test(String(event.time)) && Date.parse(String(event.time)) <= Date.now()
      && !/\d+\.\d{4,},\s*\d+\.\d{4,}/.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SKROUTZ_LAST_MILE_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SKROUTZ_LAST_MILE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SKROUTZ_LAST_MILE_UNKNOWN_NUMBER)('reads an unknown voucher as not found', async () => {
    await expect(direct().track({ number: process.env.SKROUTZ_LAST_MILE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
