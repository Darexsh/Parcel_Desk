import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TNT Italy live retrieval', () => {
  it.skipIf(!process.env.TNT_IT_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TNT_IT_TRACKING_NUMBER!, carrier: 'tnt-it' });
    expect(answer).toMatchObject({ carrier: 'tnt-it', source: 'tnt-it' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tnt-it', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a depot's clock in Italian time, with a code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+0[12]:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TNT_IT_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.TNT_IT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TNT_IT_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.TNT_IT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
