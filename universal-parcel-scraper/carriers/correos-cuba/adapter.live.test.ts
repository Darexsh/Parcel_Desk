import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CorreosCubaTracker } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracker asks the current year and the one before; an older item needs its own year.
const YEAR = Number(process.env.CORREOS_CUBA_TRACKING_YEAR) || undefined;
// A day and a clock to the second, with no zone.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Correos de Cuba live retrieval', () => {
  it.skipIf(!process.env.CORREOS_CUBA_TRACKING_NUMBER || YEAR)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.CORREOS_CUBA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'correos-cuba' });
    expect(answer).toMatchObject({ carrier: 'correos-cuba', source: 'correos-cuba' });
    expect(answer.attempts[0]).toMatchObject({ source: 'correos-cuba', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => WALL_CLOCK.test(String(event.local_time)) && event.time === undefined)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!process.env.CORREOS_CUBA_TRACKING_NUMBER || !YEAR)('retrieves an older item in the year it asks', async () => {
    const result = await new CorreosCubaTracker({ now: () => Date.UTC(YEAR!, 6, 1) }).fetch(process.env.CORREOS_CUBA_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => WALL_CLOCK.test(String(event.local_time)) && event.time === undefined && event.description)).toBe(true);
    await expect(direct().track({ number: process.env.CORREOS_CUBA_TRACKING_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 60_000);

  it.skipIf(!process.env.CORREOS_CUBA_UNKNOWN_NUMBER)('reads a code the tracker holds nothing for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.CORREOS_CUBA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct().recognize!(process.env.CORREOS_CUBA_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 60_000);
});
