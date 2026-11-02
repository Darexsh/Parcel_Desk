import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Royal Express live retrieval', () => {
  it.skipIf(!process.env.ROYAL_EXPRESS_MM_TRACKING_NUMBER)('reads the requested waybill’s history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ROYAL_EXPRESS_MM_TRACKING_NUMBER!, carrier: 'royal-express-mm' });
    expect(answer).toMatchObject({ carrier: 'royal-express-mm', source: 'royal-express-mm' });
    expect(answer.attempts[0]).toMatchObject({ source: 'royal-express-mm', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wall clock without an offset, a code and the office that made it.
    for (const event of answer.result.events) {
      expect(event).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
        provider_code: expect.any(String), location: expect.any(String), description: expect.any(String) });
    }
    await expect(direct().recognize!(process.env.ROYAL_EXPRESS_MM_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ROYAL_EXPRESS_MM_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.ROYAL_EXPRESS_MM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
