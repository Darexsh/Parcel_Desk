import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('J&T Express Germany live retrieval', () => {
  it.skipIf(!process.env.J_AND_T_DE_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.J_AND_T_DE_TRACKING_NUMBER!, carrier: 'j-and-t-de' });
    expect(answer).toMatchObject({ carrier: 'j-and-t-de', source: 'j-and-t-de' });
    expect(answer.attempts[0]).toMatchObject({ source: 'j-and-t-de', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan time is an instant in UTC, the zone the request names.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.J_AND_T_DE_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.J_AND_T_DE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.J_AND_T_DE_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.J_AND_T_DE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.J_AND_T_DE_UNKNOWN_NUMBER!)).resolves.toMatchObject({ known: false });
  });
});
