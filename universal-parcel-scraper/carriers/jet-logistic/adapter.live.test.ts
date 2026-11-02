import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jet Logistic live retrieval', () => {
  it.skipIf(!process.env.JET_LOGISTIC_TRACKING_NUMBER)('retrieves the history of the requested cargo with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JET_LOGISTIC_TRACKING_NUMBER!, carrier: 'jet-logistic' });
    expect(answer).toMatchObject({ carrier: 'jet-logistic', source: 'jet-logistic' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jet-logistic', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step keeps its wall clock, or its day alone, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.JET_LOGISTIC_TRACKING_NUMBER)('recognizes the requested cargo', async () => {
    await expect(direct().recognize!(process.env.JET_LOGISTIC_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.JET_LOGISTIC_UNKNOWN_NUMBER)('reads an unknown cargo as not found', async () => {
    await expect(direct().track({ number: process.env.JET_LOGISTIC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
