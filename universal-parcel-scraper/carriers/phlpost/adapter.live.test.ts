import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const MANILA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const dated = (event: { time?: string | null; local_time?: string }) => MANILA.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time));

describe('PHLPost live retrieval', () => {
  it.skipIf(!process.env.PHLPOST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.PHLPOST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'phlpost' });
    expect(answer).toMatchObject({ carrier: 'phlpost', source: 'phlpost' });
    // An item PHLPost sent abroad is handed on to the destination's post too.
    expect(answer.attempts[0]).toMatchObject({ source: 'phlpost', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && event.provider_code && dated(event))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PHLPOST_INBOUND_NUMBER)('retrieves the scans of mail from abroad, with Manila instants for PHLPost’s own', async () => {
    const result = await direct().track({ number: process.env.PHLPOST_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(dated)).toBe(true);
    expect(result.events!.some(event => MANILA.test(String(event.time)))).toBe(true);
    expect(result.destination_country).toBe('PH');
  }, 30_000);

  it.skipIf(!process.env.PHLPOST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.PHLPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PHLPOST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
