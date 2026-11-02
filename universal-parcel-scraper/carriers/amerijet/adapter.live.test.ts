import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Amerijet live retrieval', () => {
  it.skipIf(!process.env.AMERIJET_TRACKING_NUMBER)('retrieves the history of the requested air waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AMERIJET_TRACKING_NUMBER!, carrier: 'amerijet' });
    expect(answer).toMatchObject({ carrier: 'amerijet', source: 'amerijet' });
    expect(answer.attempts[0]).toMatchObject({ source: 'amerijet', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its station's wall clock, without an offset, and its milestone.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.AMERIJET_TRACKING_NUMBER)('recognizes the requested air waybill', async () => {
    await expect(direct().recognize!(process.env.AMERIJET_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.AMERIJET_UNKNOWN_NUMBER)('reads an unknown air waybill as not found', async () => {
    await expect(direct().track({ number: process.env.AMERIJET_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
