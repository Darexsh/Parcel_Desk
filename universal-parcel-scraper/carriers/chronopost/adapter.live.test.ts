import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ChronopostTracker } from './adapter.js';

describe('Chronopost live direct tracking', () => {
  it('returns a bound empty history for an unknown postal-shaped number', async () => {
    await expect(new ChronopostTracker().fetch('XY000000005FR')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.CHRONOPOST_TRACKING_NUMBER)('retrieves and recognizes a private reference through direct HTTP', async () => {
    const number = process.env.CHRONOPOST_TRACKING_NUMBER!;
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const result = await instance.track({ number }, { budgetMs: 15_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_update).toBeTruthy();
    await expect(instance.recognize!(number, { budgetMs: 15_000 })).resolves.toMatchObject({ known: true });
  });
});
