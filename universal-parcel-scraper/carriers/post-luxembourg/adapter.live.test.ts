import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('POST Luxembourg live retrieval', () => {
  it.skipIf(!process.env.POST_LUXEMBOURG_TRACKING_NUMBER)('retrieves dated history for the requested item with providers disabled', async () => {
    const number = process.env.POST_LUXEMBOURG_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'post-luxembourg' });
    expect(answer).toMatchObject({ carrier: 'post-luxembourg', source: 'post-luxembourg', attempts: [{ source: 'post-luxembourg', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)) && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POST_LUXEMBOURG_UNKNOWN_NUMBER)('reads the not-found word for an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.POST_LUXEMBOURG_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POST_LUXEMBOURG_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
