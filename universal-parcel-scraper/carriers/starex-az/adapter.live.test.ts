import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const NUMBER = process.env.STAREX_AZ_TRACKING_NUMBER;
const UNKNOWN = process.env.STAREX_AZ_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Starex live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the scans of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'starex-az' });
    expect(answer).toMatchObject({ carrier: 'starex-az', source: 'starex-az' });
    expect(answer.attempts[0]).toMatchObject({ source: 'starex-az', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset, and its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(NUMBER!)).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(UNKNOWN!)).resolves.toEqual({ known: false });
  }, 30_000);
});
