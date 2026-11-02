import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PCS Logistics live retrieval', () => {
  it.skipIf(!process.env.PCS_LOGISTICS_VN_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PCS_LOGISTICS_VN_TRACKING_NUMBER!, carrier: 'pcs-logistics-vn' });
    expect(answer).toMatchObject({ carrier: 'pcs-logistics-vn', source: 'pcs-logistics-vn' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pcs-logistics-vn', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan in Vietnam is an instant on Vietnam's clock; any other keeps its wall clock to the second.
    expect(answer.result.events.every((event) => (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(String(event.time)) && !event.local_time
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.description && event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PCS_LOGISTICS_VN_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.PCS_LOGISTICS_VN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PCS_LOGISTICS_VN_NO_HISTORY_NUMBER)('reads a waybill the tracker knows without scans as no history', async () => {
    await expect(direct().track({ number: process.env.PCS_LOGISTICS_VN_NO_HISTORY_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  }, 45_000);

  it.skipIf(!process.env.PCS_LOGISTICS_VN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PCS_LOGISTICS_VN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
