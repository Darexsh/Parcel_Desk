import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Fukuyama Transporting live retrieval', () => {
  it.skipIf(!process.env.FUKUYAMA_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FUKUYAMA_TRACKING_NUMBER!, carrier: 'fukuyama' });
    expect(answer).toMatchObject({ carrier: 'fukuyama', source: 'fukuyama' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fukuyama', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is a minute in Japan's zone, or a day alone for the dispatch row.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+09:00$/.test(String(event.time))
      : /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.FUKUYAMA_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.FUKUYAMA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FUKUYAMA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FUKUYAMA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
