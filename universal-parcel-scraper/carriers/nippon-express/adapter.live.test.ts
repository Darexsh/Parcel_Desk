import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Nippon Express live retrieval', () => {
  it.skipIf(!process.env.NIPPON_EXPRESS_TRACKING_NUMBER)('retrieves the list’s summary for the requested number with providers disabled', async () => {
    const number = process.env.NIPPON_EXPRESS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'nippon-express' });
    expect(answer).toMatchObject({ carrier: 'nippon-express', source: 'nippon-express', attempts: [{ source: 'nippon-express', kind: 'ok' }] });
    expect(answer.result).toMatchObject({ summary_only: true, events: [], last_status_text: expect.any(String) });
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NIPPON_EXPRESS_UNKNOWN_NUMBER)('reads the list’s no-data row for an unknown number as not found', async () => {
    const number = process.env.NIPPON_EXPRESS_UNKNOWN_NUMBER!;
    await expect(direct().track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(number)).resolves.toEqual({ known: false });
  });
});
