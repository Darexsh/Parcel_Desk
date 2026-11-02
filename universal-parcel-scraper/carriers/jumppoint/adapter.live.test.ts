import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jumppoint live retrieval', () => {
  it.skipIf(!process.env.JUMPPOINT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JUMPPOINT_TRACKING_NUMBER!, carrier: 'jumppoint' });
    expect(answer).toMatchObject({ carrier: 'jumppoint', source: 'jumppoint' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jumppoint', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is an instant on Hong Kong's clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.JUMPPOINT_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.JUMPPOINT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.JUMPPOINT_CREATED_NUMBER)('reads a waybill without a status log as a summary', async () => {
    await expect(direct().track({ number: process.env.JUMPPOINT_CREATED_NUMBER! }))
      .resolves.toMatchObject({ summary_only: true, provider_code: expect.stringMatching(/^[A-Z_]+$/), events: [] });
  });

  it.skipIf(!process.env.JUMPPOINT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JUMPPOINT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
