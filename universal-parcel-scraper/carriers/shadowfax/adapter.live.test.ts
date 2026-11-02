import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shadowfax live retrieval', () => {
  it.skipIf(!process.env.SHADOWFAX_TRACKING_NUMBER)('retrieves the history of the requested AWB with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHADOWFAX_TRACKING_NUMBER!, carrier: 'shadowfax' });
    expect(answer).toMatchObject({ carrier: 'shadowfax', source: 'shadowfax' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shadowfax', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries India's time.
    expect(answer.result.events.every((event) => event.description && /\+05:30$/.test(String(event.time)) && event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SHADOWFAX_TRACKING_NUMBER)('recognizes the requested AWB', async () => {
    await expect(direct().recognize!(process.env.SHADOWFAX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.SHADOWFAX_UNKNOWN_NUMBER)('reads an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.SHADOWFAX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
