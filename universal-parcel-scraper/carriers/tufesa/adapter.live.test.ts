import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TufesaPack live retrieval', () => {
  it.skipIf(!process.env.TUFESA_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TUFESA_TRACKING_NUMBER!, carrier: 'tufesa' });
    expect(answer).toMatchObject({ carrier: 'tufesa', source: 'tufesa' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tufesa', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset, its code and no receiver.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && !/RECIBIDO POR/i.test(event.description) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.TUFESA_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.TUFESA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TUFESA_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.TUFESA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
