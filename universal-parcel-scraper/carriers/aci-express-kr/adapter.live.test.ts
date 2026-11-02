import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const POSTED = process.env.ACI_EXPRESS_KR_TRACKING_NUMBER;
const CJ = process.env.ACI_EXPRESS_KR_CJ_NUMBER;
const UNKNOWN = process.env.ACI_EXPRESS_KR_UNKNOWN_NUMBER;

// Every scan keeps its site's wall clock without an offset, a day alone where the page has no time.
const localScans = (result: CarrierResult) => result.events!.every((event) => event.description && !event.time
  && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)));

describe('ACI Express live retrieval', () => {
  it.skipIf(!POSTED)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: POSTED!, carrier: 'aci-express-kr' });
    expect(answer).toMatchObject({ carrier: 'aci-express-kr', source: 'aci-express-kr' });
    expect(answer.attempts[0]).toMatchObject({ source: 'aci-express-kr', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
  }, 75_000);

  it.skipIf(!POSTED)('reads ACI’s milestones and Korea Post’s scans, and hands the parcel to Korea Post under its number', async () => {
    const result = await direct().track({ number: POSTED! });
    expect(result).toMatchObject({ delivery_carrier: 'korea-post', delivery_tracking_number: POSTED });
    expect(result.current_stage).toBeTruthy();
    expect(localScans(result)).toBe(true);
    expect(result.events!.some((event) => event.stage === 'accepted')).toBe(true);
    expect(result.events!.some((event) => /^[A-Z. ]+$/.test(event.description!))).toBe(true);
    expect(result.receiver_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!CJ)('reads a parcel CJ Logistics delivers under ACI’s own number', async () => {
    const result = await direct().track({ number: CJ! });
    expect(result.current_stage).toBeTruthy();
    expect(localScans(result)).toBe(true);
    expect(result.events!.some((event) => /[가-힣]/.test(event.description!))).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
  }, 45_000);

  it.skipIf(!POSTED)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(POSTED!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads a number neither lookup knows as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(UNKNOWN!)).resolves.toEqual({ known: false });
  }, 45_000);
});
