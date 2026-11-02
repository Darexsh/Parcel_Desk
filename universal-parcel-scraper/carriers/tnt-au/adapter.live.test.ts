import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TNT Australia live retrieval', () => {
  it.skipIf(!process.env.TNT_AU_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TNT_AU_TRACKING_NUMBER!, carrier: 'tnt-au' });
    expect(answer).toMatchObject({ carrier: 'tnt-au', source: 'tnt-au' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tnt-au', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording, its depot and an instant on an Australian clock.
    expect(answer.result.events.every((event) => event.description && event.location && /\+(?:0[89]|1[01]):(?:00|30)$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TNT_AU_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.TNT_AU_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TNT_AU_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TNT_AU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
