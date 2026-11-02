import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CTTYEX live retrieval', () => {
  it.skipIf(!process.env.CTTYEX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CTTYEX_TRACKING_NUMBER!, carrier: 'cttyex' });
    expect(answer).toMatchObject({ carrier: 'cttyex', source: 'cttyex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cttyex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // CTTYEX's steps in China are seconds on Beijing time; any other wording keeps its wall clock.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(event.time))
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CTTYEX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.CTTYEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CTTYEX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CTTYEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
