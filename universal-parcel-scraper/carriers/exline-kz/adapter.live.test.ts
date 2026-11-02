import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Exline live retrieval', () => {
  it.skipIf(!process.env.EXLINE_KZ_TRACKING_NUMBER)('retrieves dated scans for the requested waybill with providers disabled', async () => {
    const number = process.env.EXLINE_KZ_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'exline-kz' });
    expect(answer).toMatchObject({ carrier: 'exline-kz', source: 'exline-kz', attempts: [{ source: 'exline-kz', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its branch's wall clock, without an offset, and its MeaSoft code.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.EXLINE_KZ_UNKNOWN_NUMBER)('reads an unknown waybill number as not found', async () => {
    await expect(direct().track({ number: process.env.EXLINE_KZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.EXLINE_KZ_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
