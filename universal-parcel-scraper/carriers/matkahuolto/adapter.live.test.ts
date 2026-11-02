import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Matkahuolto live retrieval', () => {
  it.skipIf(!process.env.MATKAHUOLTO_TRACKING_NUMBER)('retrieves dated history for the requested number with providers disabled', async () => {
    const number = process.env.MATKAHUOLTO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'matkahuolto' });
    expect(answer).toMatchObject({ carrier: 'matkahuolto', source: 'matkahuolto', attempts: [{ source: 'matkahuolto', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && !event.time && event.description)).toBe(true);
    if (/^M[AH]/i.test(number)) await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.MATKAHUOLTO_UNKNOWN_NUMBER)('reads the reply for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MATKAHUOLTO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.MATKAHUOLTO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
