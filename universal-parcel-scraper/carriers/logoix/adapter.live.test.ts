import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracker asks for a pause of ten seconds between lookups from one address.
const pause = () => new Promise((resolve) => setTimeout(resolve, 11_000));

describe('LogoiX live retrieval', () => {
  it.skipIf(!process.env.LOGOIX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LOGOIX_TRACKING_NUMBER!, carrier: 'logoix' });
    expect(answer).toMatchObject({ carrier: 'logoix', source: 'logoix' });
    expect(answer.attempts[0]).toMatchObject({ source: 'logoix', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan's clock reads as Berlin time, and no hidden row becomes a scan.
    expect(answer.result.events.every((event) => event.description && /T\d{2}:\d{2}:00\+0[12]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => /AUTORISIERTE/.test(String(event.description)))).toBe(false);
  }, 45_000);

  it.skipIf(!process.env.LOGOIX_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await pause();
    await expect(direct().recognize!(process.env.LOGOIX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.LOGOIX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await pause();
    await expect(direct().track({ number: process.env.LOGOIX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
