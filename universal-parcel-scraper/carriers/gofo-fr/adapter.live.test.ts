import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
describe('GOFO France live tracking', () => {
  it.skipIf(!process.env.GOFO_FR_TRACKING_NUMBER)('returns matching national history and HTTP confirmation', async () => {
    const number = process.env.GOFO_FR_TRACKING_NUMBER!;
    const result = normalizeCarrierResult(await instance().track({ number }, { budgetMs: 15_000 }));
    expect(result.destination_country).toBe('FR'); expect(result.canonical_tracking_number).toMatch(/^(?:GF|CI)FR\d{13,14}$/);
    expect(result.events?.length).toBeGreaterThan(0); expect(result.events?.some(event => event.time || event.local_time)).toBe(true);
    expect(await instance().recognize!(number, { budgetMs: 15_000 })).toMatchObject({ known: true });
  }, 35_000);
  it.skipIf(!process.env.GOFO_FR_UNKNOWN_NUMBER)('keeps an empty valid lookup inconclusive', async () => {
    await expect(instance().track({ number: process.env.GOFO_FR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 20_000);
});
