import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SAPX Express live retrieval', () => {
  it.skipIf(!process.env.SAPX_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SAPX_EXPRESS_TRACKING_NUMBER!, carrier: 'sapx-express' });
    expect(answer).toMatchObject({ carrier: 'sapx-express', source: 'sapx-express', attempts: [{ source: 'sapx-express', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.receiver_name).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
    // No remark is kept, and no heading names who took the parcel.
    expect(answer.result.events.some((event) => /\b(?:oleh|kurir:|penerima:|keterangan)/i.test(String(event.description)))).toBe(false);
  }, 30_000);

  it.skipIf(!process.env.SAPX_EXPRESS_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.SAPX_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SAPX_EXPRESS_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SAPX_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SAPX_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
