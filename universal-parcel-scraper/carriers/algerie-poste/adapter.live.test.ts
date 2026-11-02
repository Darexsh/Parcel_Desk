import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A day, or a day and a clock to the minute, with no zone.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/;

describe('Algérie Poste live retrieval', () => {
  it.skipIf(!process.env.ALGERIE_POSTE_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.ALGERIE_POSTE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'algerie-poste' });
    expect(answer).toMatchObject({ carrier: 'algerie-poste', source: 'algerie-poste' });
    expect(answer.attempts[0]).toMatchObject({ source: 'algerie-poste', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => WALL_CLOCK.test(String(event.local_time)) && event.time === undefined)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ALGERIE_POSTE_INBOUND_NUMBER)('retrieves an item from abroad with the clocks of its EMS scans', async () => {
    const result = await direct().track({ number: process.env.ALGERIE_POSTE_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.some(event => /T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.ALGERIE_POSTE_UNKNOWN_NUMBER)('reads a number the tracker holds nothing for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.ALGERIE_POSTE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct().recognize!(process.env.ALGERIE_POSTE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});
