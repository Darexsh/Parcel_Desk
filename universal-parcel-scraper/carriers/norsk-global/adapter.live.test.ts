import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NorskGlobalTracker } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Norsk Global live retrieval', () => {
  it.skipIf(!process.env.NORSK_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NORSK_GLOBAL_TRACKING_NUMBER!, carrier: 'norsk-global' });
    expect(answer).toMatchObject({ carrier: 'norsk-global', source: 'norsk-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'norsk-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and a clock: an instant when the reply gives an offset, else the wall clock.
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.NORSK_GLOBAL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.NORSK_GLOBAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NORSK_GLOBAL_UNKNOWN_NUMBER)('reads an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.NORSK_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.NORSK_GLOBAL_UNKNOWN_NUMBER)('reads the client token the tracking page gives now', async () => {
    // A token the lookup refuses sends the adapter to the page for the current one.
    await expect(new NorskGlobalTracker({ token: 'REFUSEDTOKEN0000' }).fetch(process.env.NORSK_GLOBAL_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'not_found' });
  });
});
