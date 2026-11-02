import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Servientrega live retrieval', () => {
  it.skipIf(!process.env.SERVIENTREGA_TRACKING_NUMBER)('retrieves the history of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SERVIENTREGA_TRACKING_NUMBER!, carrier: 'servientrega' });
    expect(answer).toMatchObject({ carrier: 'servientrega', source: 'servientrega' });
    expect(answer.attempts[0]).toMatchObject({ source: 'servientrega', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement has its code, wording and town, and a clock in Bogotá's time.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.location
      && /-05:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SERVIENTREGA_TRACKING_NUMBER)('recognizes the requested guide', async () => {
    await expect(direct().recognize!(process.env.SERVIENTREGA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.SERVIENTREGA_UNKNOWN_NUMBER)('reads an unknown guide as not found', async () => {
    await expect(direct().track({ number: process.env.SERVIENTREGA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
