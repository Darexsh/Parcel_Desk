import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const postcode = process.env.IDS_LOGISTIK_POSTCODE;

describe('IDS Logistik live retrieval', () => {
  it.skipIf(!process.env.IDS_LOGISTIK_TRACKING_NUMBER || !postcode)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.IDS_LOGISTIK_TRACKING_NUMBER!, carrier: 'ids-logistik', postcode: postcode! });
    expect(answer).toMatchObject({ carrier: 'ids-logistik', source: 'ids-logistik' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ids-logistik', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated, with the offset the reply gives or German time's.
    expect(answer.result.events.every((event) => event.description && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.IDS_LOGISTIK_UNKNOWN_NUMBER || !postcode)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.IDS_LOGISTIK_UNKNOWN_NUMBER!, postcode })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
