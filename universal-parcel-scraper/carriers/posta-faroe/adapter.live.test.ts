import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const FAROE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[01]:00$/;

describe('Posta live retrieval', () => {
  it.skipIf(!process.env.POSTA_FAROE_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const number = process.env.POSTA_FAROE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-faroe' });
    expect(answer).toMatchObject({ carrier: 'posta-faroe', source: 'posta-faroe', attempts: [{ source: 'posta-faroe', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && (FAROE.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time))))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.POSTA_FAROE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_FAROE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_FAROE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
