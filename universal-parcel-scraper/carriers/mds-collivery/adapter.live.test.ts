import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MDS Collivery live retrieval', () => {
  it.skipIf(!process.env.MDS_COLLIVERY_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MDS_COLLIVERY_TRACKING_NUMBER!, carrier: 'mds-collivery' });
    expect(answer).toMatchObject({ carrier: 'mds-collivery', source: 'mds-collivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mds-collivery', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant at South African time, with its line.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+02:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MDS_COLLIVERY_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.MDS_COLLIVERY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.MDS_COLLIVERY_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.MDS_COLLIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
