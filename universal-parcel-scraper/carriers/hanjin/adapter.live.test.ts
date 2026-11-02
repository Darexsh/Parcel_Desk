import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hanjin live retrieval', () => {
  it.skipIf(!process.env.HANJIN_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HANJIN_TRACKING_NUMBER!, carrier: 'hanjin' });
    expect(answer).toMatchObject({ carrier: 'hanjin', source: 'hanjin' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hanjin', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans in Korea carry Korean time; scans abroad keep their wall clock.
    expect(answer.result.events.every((event) => event.description && (/\+09:00$/.test(String(event.time))
      || (!event.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.HANJIN_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.HANJIN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.HANJIN_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.HANJIN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
