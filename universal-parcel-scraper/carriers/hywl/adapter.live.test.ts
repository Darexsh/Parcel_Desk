import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huiyi Logistics live retrieval', () => {
  it.skipIf(!process.env.HYWL_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const number = process.env.HYWL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'hywl' });
    expect(answer).toMatchObject({ carrier: 'hywl', source: 'hywl', attempts: [expect.objectContaining({ source: 'hywl', kind: 'ok' })] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.local_time && !event.time && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.HYWL_UNKNOWN_NUMBER)('reads the service’s unknown-number answer as not found', async () => {
    await expect(direct().track({ number: process.env.HYWL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.HYWL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
