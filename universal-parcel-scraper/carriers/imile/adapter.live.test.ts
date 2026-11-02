import { describe, expect, it } from 'vitest';
import type { CarrierEvent } from '../../core/result/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ImileTracker } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CAINIAO_CODE = /^[A-Z_]+$/;
const ownScan = (event: CarrierEvent) => !CAINIAO_CODE.test(String(event.provider_code ?? ''));

describe('iMile live retrieval', () => {
  it.skipIf(!process.env.IMILE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.IMILE_TRACKING_NUMBER!, carrier: 'imile' });
    expect(answer).toMatchObject({ carrier: 'imile', source: 'imile' });
    expect(answer.attempts[0]).toMatchObject({ source: 'imile', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every iMile scan is placed on the recipient country's clock, or keeps it
    // local when the country spans several zones.
    expect(answer.result.events.filter(ownScan).every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(event.time)
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    // Most scans carry a stage code; a few come without one.
    expect(answer.result.events.some((event) => event.provider_code)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.IMILE_CAINIAO_TRACKING_NUMBER)('puts Cainiao’s leg in front of iMile’s scans, keeping iMile’s status, for a parcel both handled', async () => {
    const number = process.env.IMILE_CAINIAO_TRACKING_NUMBER!;
    const steps: Parameters<StepRecorder['step']>[0][] = [];
    const recorder: StepRecorder = { ...NOOP_RECORDER, step: (step) => { steps.push(step); } };
    const own = await new ImileTracker().fetch(number, {}, { cainiao: false });
    const merged = await adapter({ recorder, env: {}, trawl: null, browserExecutablePath: null }).track({ number });
    expect(steps.find((step) => step.step === 'cainiao')).toMatchObject({ outcome: 'ok' });
    expect(merged.events!.filter(ownScan)).toEqual(own.events);
    expect({ ...merged, events: own.events }).toEqual(own);
    const leg = merged.events!.filter((event) => !ownScan(event));
    expect(leg.length).toBeGreaterThan(0);
    // Cainiao's scans are placed in its own zone, or keep a day or a wall clock it did not place.
    expect(leg.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(event.time)
      : /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time))))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.IMILE_UNKNOWN_NUMBER)('reads an unknown number as not found after checking the page’s key', async () => {
    await expect(direct().track({ number: process.env.IMILE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
