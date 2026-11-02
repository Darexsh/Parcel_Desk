import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/;

describe('Fargo live retrieval', () => {
  it.skipIf(!process.env.FARGO_UZ_TRACKING_NUMBER)('retrieves dated scans for the requested order with providers disabled', async () => {
    const number = process.env.FARGO_UZ_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'fargo-uz' });
    expect(answer).toMatchObject({ carrier: 'fargo-uz', source: 'fargo-uz', attempts: [{ source: 'fargo-uz', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && INSTANT.test(String(event.time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.FARGO_UZ_UNKNOWN_NUMBER)('reads an unknown track ID as not found', async () => {
    await expect(direct().track({ number: process.env.FARGO_UZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.FARGO_UZ_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
