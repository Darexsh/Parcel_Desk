import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Forward Air live retrieval', () => {
  it.skipIf(!process.env.FORWARD_AIR_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FORWARD_AIR_TRACKING_NUMBER!, carrier: 'forward-air' });
    expect(answer).toMatchObject({ carrier: 'forward-air', source: 'forward-air' });
    expect(answer.attempts[0]).toMatchObject({ source: 'forward-air', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its code, its wording and a station clock, as an instant or a wall clock.
    expect(answer.result.events.every((event) => event.description && /^[A-Z]{2,8}$/.test(String(event.provider_code))
      && (event.local_time || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FORWARD_AIR_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.FORWARD_AIR_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FORWARD_AIR_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.FORWARD_AIR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
