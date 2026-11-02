import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('Emile live tracking', () => {
  it.skipIf(!process.env.EMILE_TRACKING_NUMBER)('returns matching dated history over anonymous HTTP', async () => {
    const number = process.env.EMILE_TRACKING_NUMBER!;
    const result = normalizeCarrierResult(await instance().track({ number }, { budgetMs: 15_000 }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some(event => event.time || event.local_time)).toBe(true);
    expect(await instance().recognize!(number, { budgetMs: 15_000 })).toMatchObject({ known: true });
  }, 35_000);

  it.skipIf(!process.env.EMILE_UNKNOWN_NUMBER)('identifies an explicitly absent parcel', async () => {
    const number = process.env.EMILE_UNKNOWN_NUMBER!;
    await expect(instance().track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    expect(await instance().recognize!(number)).toEqual({ known: false });
  }, 35_000);
});
