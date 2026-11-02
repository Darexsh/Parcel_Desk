import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TK Energia live retrieval', () => {
  it.skipIf(!process.env.ENERGIA_TK_TRACKING_NUMBER)('retrieves the current state of the requested receipt with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ENERGIA_TK_TRACKING_NUMBER!, carrier: 'energia-tk' });
    expect(answer).toMatchObject({ carrier: 'energia-tk', source: 'energia-tk', result: { summary_only: true } });
    expect(answer.attempts[0]).toMatchObject({ source: 'energia-tk', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every state is an instant or, with the sender, undated.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && (event.time === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time))))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.ENERGIA_TK_TRACKING_NUMBER)('recognizes the requested receipt', async () => {
    await expect(direct().recognize!(process.env.ENERGIA_TK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ENERGIA_TK_UNKNOWN_NUMBER)('reads an unknown receipt as not found', async () => {
    await expect(direct().track({ number: process.env.ENERGIA_TK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
