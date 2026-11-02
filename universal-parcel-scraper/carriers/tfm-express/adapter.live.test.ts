import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TFM Express live retrieval', () => {
  it.skipIf(!process.env.TFM_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested airwaybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TFM_EXPRESS_TRACKING_NUMBER!, carrier: 'tfm-express' });
    expect(answer).toMatchObject({ carrier: 'tfm-express', source: 'tfm-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tfm-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is an instant to the minute at Dubai's offset, with its status name as the provider code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+04:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ provider_code: 'Shipment Created', stage: 'registered' });
  }, 45_000);

  it.skipIf(!process.env.TFM_EXPRESS_TRACKING_NUMBER)('recognizes the requested airwaybill', async () => {
    await expect(direct().recognize!(process.env.TFM_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TFM_EXPRESS_UNKNOWN_NUMBER)('reads an unknown airwaybill as not found', async () => {
    await expect(direct().track({ number: process.env.TFM_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
