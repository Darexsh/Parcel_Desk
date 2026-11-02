import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { MONGOL_INFINITY_POST_TRACKING_NUMBER: TRACKING, MONGOL_INFINITY_POST_BARCODE_NUMBER: BARCODE,
  MONGOL_INFINITY_POST_UNKNOWN_NUMBER: UNKNOWN, MONGOL_INFINITY_POST_CUSTOMS_NUMBER: CUSTOMS,
  MONGOL_INFINITY_POST_CUSTOMS_UNKNOWN_NUMBER: CUSTOMS_UNKNOWN } = process.env;

describe('Mongol Infinity Post live retrieval', () => {
  it.skipIf(!TRACKING)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: TRACKING!, carrier: 'mongol-infinity-post' });
    expect(answer).toMatchObject({ carrier: 'mongol-infinity-post', source: 'mongol-infinity-post' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mongol-infinity-post', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has the reply's own UTC instant.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time)))).toBe(true);
    if (BARCODE && BARCODE !== TRACKING) expect(answer.result.canonical_tracking_number).toBe(BARCODE);
  }, 45_000);

  it.skipIf(!BARCODE)('retrieves the same parcel by its barcode', async () => {
    const result = await direct().track({ number: BARCODE! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.canonical_tracking_number).toBeUndefined();
  }, 45_000);

  it.skipIf(!TRACKING)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(TRACKING!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);

  it.skipIf(!CUSTOMS)('reads a customs item’s statuses', async () => {
    const result = await direct().track({ number: CUSTOMS! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => event.description && /^CUSTOMS_/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!CUSTOMS_UNKNOWN)('reads an item the customs lookup does not know as not found', async () => {
    await expect(direct().track({ number: CUSTOMS_UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
