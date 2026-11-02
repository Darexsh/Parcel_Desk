import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Indah Logistik live retrieval', () => {
  it.skipIf(!process.env.INDAH_LOGISTIK_TRACKING_NUMBER)('retrieves the history of the requested resi with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.INDAH_LOGISTIK_TRACKING_NUMBER!, carrier: 'indah-logistik' });
    expect(answer).toMatchObject({ carrier: 'indah-logistik', source: 'indah-logistik' });
    expect(answer.attempts[0]).toMatchObject({ source: 'indah-logistik', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps the lookup's wall clock, without an offset, and its wording before the dash.
    expect(answer.result.events.every((event) => event.description && !event.time && !/ - /.test(event.description)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    // The first row is the counter's booking, in its town.
    expect(answer.result.events.at(-1)).toMatchObject({ description: 'Transaksi', stage: 'accepted', location: expect.any(String) });
  }, 45_000);

  it.skipIf(!process.env.INDAH_LOGISTIK_TRACKING_NUMBER)('recognizes the requested resi', async () => {
    await expect(direct().recognize!(process.env.INDAH_LOGISTIK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.INDAH_LOGISTIK_UNKNOWN_NUMBER)('reads an unknown resi as not found', async () => {
    await expect(direct().track({ number: process.env.INDAH_LOGISTIK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
