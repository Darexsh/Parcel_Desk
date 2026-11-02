import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Redpack live retrieval', () => {
  it.skipIf(!process.env.REDPACK_TRACKING_NUMBER)('retrieves dated history for the requested guide with providers disabled', async () => {
    const number = process.env.REDPACK_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'redpack' });
    expect(answer).toMatchObject({ carrier: 'redpack', source: 'redpack', attempts: [{ source: 'redpack', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.REDPACK_UNKNOWN_NUMBER)('reads the unknown-guide result as not found', async () => {
    await expect(direct().track({ number: process.env.REDPACK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.REDPACK_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
