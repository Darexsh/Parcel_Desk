import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/;

describe('Torrestir live retrieval', () => {
  it.skipIf(!process.env.TORRESTIR_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const number = process.env.TORRESTIR_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'torrestir' });
    expect(answer).toMatchObject({ carrier: 'torrestir', source: 'torrestir', attempts: [{ source: 'torrestir', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && WALL.test(String(event.local_time)) && !event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TORRESTIR_UNKNOWN_NUMBER)('reads a code without a shipment as not found', async () => {
    await expect(direct().track({ number: process.env.TORRESTIR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.TORRESTIR_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
