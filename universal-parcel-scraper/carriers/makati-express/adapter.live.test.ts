import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Makati Express live retrieval', () => {
  it.skipIf(!process.env.MAKATI_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested AWB with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAKATI_EXPRESS_TRACKING_NUMBER!, carrier: 'makati-express' });
    expect(answer).toMatchObject({ carrier: 'makati-express', source: 'makati-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'makati-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is a local day and an activity.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))
      && event.time === undefined)).toBe(true);
    expect(answer.result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(await direct().recognize!(process.env.MAKATI_EXPRESS_TRACKING_NUMBER!, { budgetMs: 20_000 })).toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!process.env.MAKATI_EXPRESS_UNKNOWN_NUMBER)('reads an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.MAKATI_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
