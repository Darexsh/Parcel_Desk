import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A parcel the tracker has not looked up lately takes it most of a minute.
const COLD_MS = 70_000;

describe('ICS Courier live retrieval', () => {
  it.skipIf(!process.env.ICS_COURIER_TRACKING_NUMBER)('retrieves the requested parcel’s history with providers disabled', async () => {
    const number = process.env.ICS_COURIER_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'ics-courier' });
    expect(answer).toMatchObject({ carrier: 'ics-courier', source: 'ics-courier' });
    expect(answer.attempts.at(-1)).toMatchObject({ source: 'ics-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.local_time && !event.time && event.description)).toBe(true);
  }, COLD_MS);

  it.skipIf(!process.env.ICS_COURIER_UNKNOWN_NUMBER)('reads the Not Found row for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ICS_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, COLD_MS);
});
