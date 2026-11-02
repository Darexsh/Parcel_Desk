import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/;

describe('Pošta na Severna Makedonija live retrieval', () => {
  it.skipIf(!process.env.POSTA_NORTH_MACEDONIA_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const number = process.env.POSTA_NORTH_MACEDONIA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-north-macedonia' });
    expect(answer).toMatchObject({ carrier: 'posta-north-macedonia', source: 'posta-north-macedonia',
      attempts: [{ source: 'posta-north-macedonia', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Each scan keeps its wall clock, never an instant.
    expect(answer.result.events.every((event) => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.POSTA_NORTH_MACEDONIA_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.POSTA_NORTH_MACEDONIA_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.destination_country).toBe('MK');
  }, 30_000);

  it.skipIf(!process.env.POSTA_NORTH_MACEDONIA_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_NORTH_MACEDONIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_NORTH_MACEDONIA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
