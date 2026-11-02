import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shiprocket live retrieval', () => {
  it.skipIf(!process.env.SHIPROCKET_TRACKING_NUMBER)('retrieves the history of the requested AWB with providers disabled, and recognizes it', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHIPROCKET_TRACKING_NUMBER!, carrier: 'shiprocket' });
    expect(answer).toMatchObject({ carrier: 'shiprocket', source: 'shiprocket' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shiprocket', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => (event.time || event.local_time) && event.description)).toBe(true);
    await expect(direct().recognize!(process.env.SHIPROCKET_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SHIPROCKET_UNKNOWN_NUMBER)('reads the tracker’s answer for an unknown AWB as not found, and recognizes it as unknown', async () => {
    await expect(direct().track({ number: process.env.SHIPROCKET_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SHIPROCKET_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
