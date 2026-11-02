import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AEX live retrieval', () => {
  it.skipIf(!process.env.AEX_PARAGUAY_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AEX_PARAGUAY_TRACKING_NUMBER!, carrier: 'aex-paraguay' });
    expect(answer).toMatchObject({ carrier: 'aex-paraguay', source: 'aex-paraguay', attempts: [{ source: 'aex-paraguay', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its wall clock, without an offset, and no place.
    expect(answer.result.events.every((event) => event.description && !event.time && event.location === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/Recibido por|Nro\. doc/i);
  }, 30_000);

  it.skipIf(!process.env.AEX_PARAGUAY_TRACKING_NUMBER)('recognizes the requested guía', async () => {
    await expect(direct().recognize!(process.env.AEX_PARAGUAY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.AEX_PARAGUAY_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.AEX_PARAGUAY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.AEX_PARAGUAY_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
