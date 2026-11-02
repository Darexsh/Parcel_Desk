import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jetline Couriers live retrieval', () => {
  it.skipIf(!process.env.JETLINE_COURIERS_TRACKING_NUMBER)('retrieves the history of the requested AWB number with providers disabled', async () => {
    const number = process.env.JETLINE_COURIERS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'jetline-couriers' });
    expect(answer).toMatchObject({ carrier: 'jetline-couriers', source: 'jetline-couriers', attempts: [{ source: 'jetline-couriers', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row has its wording and only its day, never an invented offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    // No branch address, phone, signatory or proof of delivery.
    expect(JSON.stringify(answer.result)).not.toMatch(/JETLINE COURIERS|\d{10}|SIGN|base64/i);
  }, 45_000);

  it.skipIf(!process.env.JETLINE_COURIERS_UNKNOWN_NUMBER)('reads the tracker’s alert for an unknown AWB number as not found', async () => {
    await expect(direct().track({ number: process.env.JETLINE_COURIERS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
