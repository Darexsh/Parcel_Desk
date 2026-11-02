import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('CORRE live retrieval', () => {
  it.skipIf(!process.env.CORRE_TRACKING_NUMBER)('retrieves the records of the requested item with providers disabled', async () => {
    const number = process.env.CORRE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'corre' });
    expect(answer).toMatchObject({ carrier: 'corre', source: 'corre', attempts: [{ source: 'corre', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every record keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CORRE_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.CORRE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CORRE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
