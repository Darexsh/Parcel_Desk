import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Quick Rabbit live retrieval', () => {
  it.skipIf(!process.env.QUICK_RABBIT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QUICK_RABBIT_TRACKING_NUMBER!, carrier: 'quick-rabbit' });
    expect(answer).toMatchObject({ carrier: 'quick-rabbit', source: 'quick-rabbit' });
    expect(answer.attempts[0]).toMatchObject({ source: 'quick-rabbit', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status has the page's label, its name and an instant.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.QUICK_RABBIT_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.QUICK_RABBIT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.QUICK_RABBIT_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.QUICK_RABBIT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
