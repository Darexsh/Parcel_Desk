import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FlashBird live retrieval', () => {
  it.skipIf(!process.env.FLASHBIRD_CA_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FLASHBIRD_CA_TRACKING_NUMBER!, carrier: 'flashbird-ca' });
    expect(answer).toMatchObject({ carrier: 'flashbird-ca', source: 'flashbird-ca' });
    expect(answer.attempts[0]).toMatchObject({ source: 'flashbird-ca', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row has FlashBird's wording and an instant on Toronto's clock.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/https?:|images|driver/i);
  }, 45_000);

  it.skipIf(!process.env.FLASHBIRD_CA_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.FLASHBIRD_CA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.FLASHBIRD_CA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FLASHBIRD_CA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
