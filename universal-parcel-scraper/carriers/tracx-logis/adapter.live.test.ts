import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TracxTracker } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TracX Logis live retrieval', () => {
  it.skipIf(!process.env.TRACX_LOGIS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TRACX_LOGIS_TRACKING_NUMBER!, carrier: 'tracx-logis' });
    expect(answer).toMatchObject({ carrier: 'tracx-logis', source: 'tracx-logis' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tracx-logis', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in UTC, with its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TRACX_LOGIS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.TRACX_LOGIS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TRACX_LOGIS_UNKNOWN_NUMBER)('reads an unknown number as not found, and finds the page’s current action', async () => {
    await expect(direct().track({ number: process.env.TRACX_LOGIS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    // An id the tracker does not have sends the lookup to the page for the current one.
    const stale = new TracxTracker({ action: 'f'.repeat(42) });
    await expect(stale.fetch(process.env.TRACX_LOGIS_UNKNOWN_NUMBER!, { budgetMs: 30_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
