import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ParcelABC live retrieval', () => {
  it.skipIf(!process.env.PARCELABC_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PARCELABC_TRACKING_NUMBER!, carrier: 'parcelabc' });
    expect(answer).toMatchObject({ carrier: 'parcelabc', source: 'parcelabc' });
    expect(answer.attempts[0]).toMatchObject({ source: 'parcelabc', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Wall clocks to the minute without an offset, each with ParcelABC's status.
    expect(events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it.skipIf(!process.env.PARCELABC_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.PARCELABC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
