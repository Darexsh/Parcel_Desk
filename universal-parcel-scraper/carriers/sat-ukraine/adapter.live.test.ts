import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SAT live retrieval', () => {
  it.skipIf(!process.env.SAT_UKRAINE_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SAT_UKRAINE_TRACKING_NUMBER!, carrier: 'sat-ukraine' });
    expect(answer).toMatchObject({ carrier: 'sat-ukraine', source: 'sat-ukraine' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sat-ukraine', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Each state is a day without a clock, with its wording and code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.current_stage).toBeDefined();
  }, 30_000);

  it.skipIf(!process.env.SAT_UKRAINE_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.SAT_UKRAINE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SAT_UKRAINE_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.SAT_UKRAINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
