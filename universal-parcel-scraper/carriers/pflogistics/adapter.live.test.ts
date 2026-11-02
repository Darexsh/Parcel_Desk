import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Parcel Freight Logistics live retrieval', () => {
  it.skipIf(!process.env.PFLOGISTICS_TRACKING_NUMBER)('retrieves complete dated history with providers disabled', async () => {
    const number = process.env.PFLOGISTICS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'pflogistics' });
    expect(answer).toMatchObject({ carrier: 'pflogistics', source: 'pflogistics' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.description && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time))).toBe(true);
    expect(answer.result.summary_only).toBeUndefined();
    expect(answer.result.history_truncated).toBeUndefined();
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PFLOGISTICS_SECOND_TRACKING_NUMBER)('retrieves another parcel through the same stateless protocol', async () => {
    const number = process.env.PFLOGISTICS_SECOND_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'pflogistics' });
    expect(answer).toMatchObject({ carrier: 'pflogistics', source: 'pflogistics' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.description)).toBe(true);
  });

  it.skipIf(!process.env.PFLOGISTICS_UNKNOWN_NUMBER)('reads the exact whole-reference absence notice as not found', async () => {
    const number = process.env.PFLOGISTICS_UNKNOWN_NUMBER!;
    await expect(direct().track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(number)).resolves.toEqual({ known: false });
  });
});
