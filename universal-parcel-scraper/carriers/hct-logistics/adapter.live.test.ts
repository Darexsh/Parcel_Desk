import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HCT Logistics live retrieval', () => {
  it.skipIf(!process.env.HCT_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HCT_LOGISTICS_TRACKING_NUMBER!, carrier: 'hct-logistics' });
    expect(answer).toMatchObject({ carrier: 'hct-logistics', source: 'hct-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hct-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans are read in Taipei time, to the minute; a notice can carry only its day.
    expect(answer.result.events.every((event) => event.description && (event.local_time
      ? /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(String(event.time))))).toBe(true);
    expect(answer.result.events.some((event) => event.location && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(answer.result)).not.toContain('tel:');
  }, 45_000);

  it.skipIf(!process.env.HCT_LOGISTICS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.HCT_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.HCT_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HCT_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
