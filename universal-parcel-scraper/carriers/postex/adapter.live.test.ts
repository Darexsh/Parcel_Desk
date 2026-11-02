import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PostEx live retrieval', () => {
  it.skipIf(!process.env.POSTEX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.POSTEX_TRACKING_NUMBER!, carrier: 'postex' });
    expect(answer).toMatchObject({ carrier: 'postex', source: 'postex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'postex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant on Pakistan's clock, with its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+05:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.POSTEX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.POSTEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POSTEX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POSTEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
