import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Laar Courier live retrieval', () => {
  it.skipIf(!process.env.LAAR_COURIER_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LAAR_COURIER_TRACKING_NUMBER!, carrier: 'laar-courier' });
    expect(answer).toMatchObject({ carrier: 'laar-courier', source: 'laar-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'laar-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the service's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.provider_code && event.stage)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.LAAR_COURIER_TRACKING_NUMBER)('recognizes the requested guía', async () => {
    await expect(direct().recognize!(process.env.LAAR_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.LAAR_COURIER_UNKNOWN_NUMBER)('reads an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.LAAR_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
