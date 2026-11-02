import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const ICELAND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

describe('Pósturinn live retrieval', () => {
  it.skipIf(!process.env.POSTURINN_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.POSTURINN_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posturinn' });
    expect(answer).toMatchObject({ carrier: 'posturinn', source: 'posturinn', attempts: [{ source: 'posturinn', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && (ICELAND.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time))))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.POSTURINN_INBOUND_NUMBER)('retrieves mail from abroad, with Pósturinn’s scans dated', async () => {
    const result = await direct().track({ number: process.env.POSTURINN_INBOUND_NUMBER! });
    expect(result).toMatchObject({ destination_country: 'IS' });
    expect(result.events!.some(event => ICELAND.test(String(event.time)))).toBe(true);
    expect(result.events!.every(event => ICELAND.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.POSTURINN_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.POSTURINN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTURINN_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
