import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Blue Express live retrieval', () => {
  it.skipIf(!process.env.BLUE_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BLUE_EXPRESS_TRACKING_NUMBER!, carrier: 'blue-express' });
    expect(answer).toMatchObject({ carrier: 'blue-express', source: 'blue-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'blue-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans keep Chile's wall clock without an offset, and their code.
    expect(answer.result.events.some((event) => event.local_time)).toBe(true);
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time)).toBe(true);
    expect(answer.result.events.every((event) => !event.local_time || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BLUE_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.BLUE_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.BLUE_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BLUE_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
