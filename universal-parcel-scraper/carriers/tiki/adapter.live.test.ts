import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TIKI live retrieval', () => {
  it.skipIf(!process.env.TIKI_TRACKING_NUMBER)('retrieves the history of the requested resi with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TIKI_TRACKING_NUMBER!, carrier: 'tiki' });
    expect(answer).toMatchObject({ carrier: 'tiki', source: 'tiki' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tiki', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its office's wall clock, without an offset, and its code.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
    // Whoever took the parcel stays out of the wording.
    expect(answer.result.events.some((event) => /(?:RECEIVED BY|PENGIRIM)\s*:/i.test(String(event.description)))).toBe(false);
  }, 75_000);

  it.skipIf(!process.env.TIKI_TRACKING_NUMBER)('recognizes the requested resi', async () => {
    await expect(direct().recognize!(process.env.TIKI_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TIKI_UNKNOWN_NUMBER)('reads an unknown resi as not found', async () => {
    await expect(direct().track({ number: process.env.TIKI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
