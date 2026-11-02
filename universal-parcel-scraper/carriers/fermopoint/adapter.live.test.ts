import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const ROME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;

describe('Fermopoint live retrieval', () => {
  it.skipIf(!process.env.FERMOPOINT_TRACKING_NUMBER)('retrieves the steps of the requested Fermoticket with providers disabled', async () => {
    const number = process.env.FERMOPOINT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'fermopoint' });
    expect(answer).toMatchObject({ carrier: 'fermopoint', source: 'fermopoint', attempts: [{ source: 'fermopoint', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && ROME.test(String(event.time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.FERMOPOINT_SHIPMENT_NUMBER)('retrieves the steps of a parcel sent from a shop', async () => {
    const result = await direct().track({ number: process.env.FERMOPOINT_SHIPMENT_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && ROME.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.FERMOPOINT_UNKNOWN_NUMBER)('reads a code without a booking as not found', async () => {
    await expect(direct().track({ number: process.env.FERMOPOINT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.FERMOPOINT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
