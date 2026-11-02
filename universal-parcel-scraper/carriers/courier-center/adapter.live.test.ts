import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Courier Center live retrieval', () => {
  it.skipIf(!process.env.COURIER_CENTER_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.COURIER_CENTER_TRACKING_NUMBER!, carrier: 'courier-center' });
    expect(answer).toMatchObject({ carrier: 'courier-center', source: 'courier-center' });
    expect(answer.attempts[0]).toMatchObject({ source: 'courier-center', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a Greek wall clock read as an instant, to the minute.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+0[23]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/\*{3}|https?:|ΤΗΛΕΦΩΝΟ|Ημ\/νια/);
  }, 75_000);

  it.skipIf(!process.env.COURIER_CENTER_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.COURIER_CENTER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.COURIER_CENTER_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.COURIER_CENTER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
