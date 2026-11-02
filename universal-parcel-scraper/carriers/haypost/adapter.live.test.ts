import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const YEREVAN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+04:00$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const dated = (event: { time?: string | null; local_time?: string }) => YEREVAN.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time));

describe('HayPost live retrieval', () => {
  it.skipIf(!process.env.HAYPOST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.HAYPOST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'haypost' });
    expect(answer).toMatchObject({ carrier: 'haypost', source: 'haypost' });
    expect(answer.attempts[0]).toMatchObject({ source: 'haypost', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && dated(event))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.HAYPOST_INBOUND_NUMBER)('retrieves the scans of mail from abroad, with Yerevan instants for HayPost’s own', async () => {
    const result = await direct().track({ number: process.env.HAYPOST_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(dated)).toBe(true);
    expect(result.events!.some(event => YEREVAN.test(String(event.time)))).toBe(true);
    expect(result.destination_country).toBe('AM');
  }, 30_000);

  it.skipIf(!process.env.HAYPOST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.HAYPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.HAYPOST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
