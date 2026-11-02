import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Leopards live retrieval', () => {
  it.skipIf(!process.env.LEOPARDS_COURIER_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LEOPARDS_COURIER_TRACKING_NUMBER!, carrier: 'leopards-courier' });
    expect(answer).toMatchObject({ carrier: 'leopards-courier', source: 'leopards-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'leopards-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and a clock in Karachi time, and no delivery wording keeps who took the parcel.
    expect(answer.result.events.every((event) => event.description && /\+05:00$/.test(String(event.time)) && !event.description.includes('~'))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LEOPARDS_COURIER_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.LEOPARDS_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.LEOPARDS_COURIER_UNKNOWN_NUMBER)('reads an unknown consignment as not found', async () => {
    await expect(direct().track({ number: process.env.LEOPARDS_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
