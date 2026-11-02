import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/;

describe('Olva Courier live retrieval', () => {
  it.skipIf(!process.env.OLVA_COURIER_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OLVA_COURIER_TRACKING_NUMBER!, carrier: 'olva-courier' });
    expect(answer).toMatchObject({ carrier: 'olva-courier', source: 'olva-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'olva-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan has a code, wording and a Peruvian wall clock without a zone.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && WALL_CLOCK.test(String(event.local_time)) && event.time === undefined)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.OLVA_COURIER_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.OLVA_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.OLVA_COURIER_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OLVA_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.OLVA_COURIER_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
