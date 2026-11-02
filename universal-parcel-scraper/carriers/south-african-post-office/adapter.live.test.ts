import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Every scan is dated on South Africa's clock.
const SOUTH_AFRICAN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+02:00$/;

describe('South African Post Office live retrieval', () => {
  it.skipIf(!process.env.SOUTH_AFRICAN_POST_OFFICE_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.SOUTH_AFRICAN_POST_OFFICE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'south-african-post-office' });
    expect(answer).toMatchObject({ carrier: 'south-african-post-office', source: 'south-african-post-office',
      attempts: [{ source: 'south-african-post-office', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && SOUTH_AFRICAN_TIME.test(String(event.time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.SOUTH_AFRICAN_POST_OFFICE_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.SOUTH_AFRICAN_POST_OFFICE_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => SOUTH_AFRICAN_TIME.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.SOUTH_AFRICAN_POST_OFFICE_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.SOUTH_AFRICAN_POST_OFFICE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SOUTH_AFRICAN_POST_OFFICE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
