import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Line Clear live retrieval', () => {
  it.skipIf(!process.env.LINE_CLEAR_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.LINE_CLEAR_TRACKING_NUMBER!, carrier: 'line-clear' });
    expect(answer).toMatchObject({ carrier: 'line-clear', source: 'line-clear' });
    expect(answer.attempts[0]).toMatchObject({ source: 'line-clear', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans at Malaysian branches and hubs are on Malaysia's clock.
    expect(answer.result.events.every((event) => event.description && /\+08:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LINE_CLEAR_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.LINE_CLEAR_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.LINE_CLEAR_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.LINE_CLEAR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
