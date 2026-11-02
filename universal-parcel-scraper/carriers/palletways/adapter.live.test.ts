import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Palletways live retrieval', () => {
  it.skipIf(!process.env.PALLETWAYS_TRACKING_NUMBER)('retrieves the requested consignment’s status with providers disabled', async () => {
    const number = process.env.PALLETWAYS_TRACKING_NUMBER!;
    const result = await direct().track({ number });
    expect(result).toMatchObject({ summary_only: true, events: [], last_status_text: expect.any(String), weight_kg: expect.any(Number) });
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'palletways' });
    expect(answer).toMatchObject({ carrier: 'palletways', source: 'palletways', attempts: [{ source: 'palletways', kind: 'ok' }] });
  });

  it.skipIf(!process.env.PALLETWAYS_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown ID as not found', async () => {
    await expect(direct().track({ number: process.env.PALLETWAYS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
