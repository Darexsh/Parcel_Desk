import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GS Postbox live retrieval', () => {
  it.skipIf(!process.env.GS_POSTBOX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GS_POSTBOX_TRACKING_NUMBER!, carrier: 'gs-postbox' });
    expect(answer).toMatchObject({ carrier: 'gs-postbox', source: 'gs-postbox' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gs-postbox', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.service_name).toBeTruthy();
    // Every scan of GS Networks or CJ Logistics is read on Korean time, to the second.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code && event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GS_POSTBOX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.GS_POSTBOX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.GS_POSTBOX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GS_POSTBOX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
