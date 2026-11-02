import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const SWEDEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;

describe('Bussgods live retrieval', () => {
  it.skipIf(!process.env.BUSSGODS_TRACKING_NUMBER)('retrieves dated scans for the requested fraktsedel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BUSSGODS_TRACKING_NUMBER!, carrier: 'bussgods' });
    expect(answer).toMatchObject({ carrier: 'bussgods', source: 'bussgods', attempts: [{ source: 'bussgods', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && SWEDEN.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BUSSGODS_TRACKING_NUMBER)('recognizes the requested fraktsedel', async () => {
    await expect(direct().recognize!(process.env.BUSSGODS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.BUSSGODS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BUSSGODS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BUSSGODS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
