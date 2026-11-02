import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Airpak Express live retrieval', () => {
  it.skipIf(!process.env.AIRPAK_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested connote with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AIRPAK_EXPRESS_TRACKING_NUMBER!, carrier: 'airpak-express' });
    expect(answer).toMatchObject({ carrier: 'airpak-express', source: 'airpak-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'airpak-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and its event number, and is dated on Singapore's or Malaysia's clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.time && !event.local_time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.AIRPAK_EXPRESS_TRACKING_NUMBER)('recognizes the requested connote', async () => {
    await expect(direct().recognize!(process.env.AIRPAK_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.AIRPAK_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.AIRPAK_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
