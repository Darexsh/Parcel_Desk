import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A scan's clock: an instant with the offset the tracker gives it.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/;

describe('MailPlus live retrieval', () => {
  it.skipIf(!process.env.MAILPLUS_AU_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAILPLUS_AU_TRACKING_NUMBER!, carrier: 'mailplus-au' });
    expect(answer).toMatchObject({ carrier: 'mailplus-au', source: 'mailplus-au' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mailplus-au', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && INSTANT.test(String(event.time)))).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.MAILPLUS_AU_PARTNER_NUMBER)('follows a parcel lodged with a partner under the partner’s barcode', async () => {
    const result = await direct().track({ number: process.env.MAILPLUS_AU_PARTNER_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.delivery_tracking_number).toMatch(/^[A-Z0-9]{4,40}$/);
    expect(result.delivery_tracking_number).not.toBe(process.env.MAILPLUS_AU_PARTNER_NUMBER);
    // The same parcel opens by that barcode.
    await expect(direct().track({ number: result.delivery_tracking_number! })).resolves.toMatchObject({ last_update: result.last_update });
  }, 45_000);

  it.skipIf(!process.env.MAILPLUS_AU_UNKNOWN_NUMBER)('reads an unknown number as not found, and recognizes it as unknown', async () => {
    await expect(direct().track({ number: process.env.MAILPLUS_AU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.MAILPLUS_AU_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
