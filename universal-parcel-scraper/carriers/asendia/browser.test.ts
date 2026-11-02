import { describe, expect, it } from 'vitest';
import { parseAsendiaGlobalResponse, asendiaBrowser } from './browser.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { asendiaTrackingApiUrl } from './probe.js';

const number = 'ASE00000000';
const parcel = () => ({ tracking_id: number, status: 'Delivered', destination_country_name: 'France',
  recipient_name: 'PRIVATE', order_id: 'PRIVATE' });
const payload = () => ({ context_code: 1000, data: [parcel()] });
describe('Asendia global portal', () => {
  it('keeps a verified current status as a summary when recipient verification hides history', () => {
    const result = parseAsendiaGlobalResponse({ ...payload(), verification_methods: { postal_code: true } }, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true, events: [], last_update: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('requires an explicit successful empty result, and binds positive results to the full identifier', () => {
    expect(() => parseAsendiaGlobalResponse({ context_code: 1000, data: [] }, number)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const value of [{ data: [] }, { context_code: 1100, data: [] }, { context_code: 1000 },
      { context_code: 1000, data: [{ ...parcel(), tracking_id: 'ASE00000001' }] },
      { context_code: 1000, data: [parcel(), parcel()] }]) {
      expect(() => parseAsendiaGlobalResponse(value, number)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
  it('reads the public client event fields without inventing offsets for wall clocks', () => {
    const result = parseAsendiaGlobalResponse({ context_code: 1000, data: [{ ...parcel(), events: [
      { event_time: '2026-01-01T10:00:00', harmonized_label: 'In transit', location_name: 'Paris', recipient_email: 'PRIVATE' },
      { event_time: '2026-01-02T11:00:00', harmonized_label: 'Delivered', location_name: 'Lyon' },
    ] }] }, number);
    expect(result.events).toMatchObject([{ local_time: '2026-01-02T11:00:00', stage: 'delivered' }, { local_time: '2026-01-01T10:00:00' }]);
    expect(result.events![0]!.time).toBeUndefined(); expect(result.last_update).toBeNull();
    expect(result.last_update_local).toBe('2026-01-02T11:00:00'); expect(result.summary_only).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rejects empty or malformed history clocks instead of losing scans', () => {
    for (const events of [null, [{}], [{ event_time: 'invalid', harmonized_label: 'Delivered' }]]) {
      expect(() => parseAsendiaGlobalResponse({ context_code: 1000, data: [{ ...parcel(), events }] }, number))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
  it('classifies captured refusal, missing request binding and malformed replies separately', async () => {
    const signal = new AbortController().signal;
    for (const [status, body, binding, kind] of [[403, null, number, 'challenge'], [429, null, number, 'rate_limited'],
      [200, JSON.stringify({ context_code: 1000, data: [] }), 'ASE00000001', 'challenge'],
      [200, '{}', number, 'schema']] as const) {
      const trawl = { scrape: async () => ({ capturedResponses: [{ url: asendiaTrackingApiUrl(), status, body,
        trackingNumberSubmitted: binding, truncated: false, base64Encoded: false, error: null }] }) } as unknown as TrawlClient;
      await expect(asendiaBrowser(trawl, number, signal, 5000)).rejects.toMatchObject({ kind });
    }
  });
  it('opens the scans with the delivery postcode and keeps the status when the portal refuses it', async () => {
    const signal = new AbortController().signal;
    const entry = (body: unknown, postcodeSubmitted?: boolean) => ({ url: asendiaTrackingApiUrl(), status: 200, body: JSON.stringify(body),
      trackingNumberSubmitted: number, truncated: false, base64Encoded: false, error: null, ...(postcodeSubmitted ? { postcodeSubmitted } : {}) });
    const locked = entry({ ...payload(), verification_methods: { postal_code: true } });
    const scans = { context_code: 1000, data: [{ ...parcel(), events: [{ event_time: '2026-01-02T11:00:00', harmonized_label: 'Delivered' }] }] };
    const urls: string[] = [];
    const trawl = (rows: unknown[]) => ({ scrape: async (request: { url: string }) => { urls.push(request.url); return { capturedResponses: rows }; } }) as unknown as TrawlClient;
    await expect(asendiaBrowser(trawl([locked, entry(scans, true)]), number, signal, 5000, 'AB1 2CD'))
      .resolves.toMatchObject({ status: 'delivered', events: [{ local_time: '2026-01-02T11:00:00' }] });
    expect(urls[0]).toBe(`https://track.asendia.com/track/${number}#trawl-postcode=AB1%202CD`);
    for (const refusal of [entry({ context_code: 1100, data: null }, true), { ...entry(scans, true), status: 403, body: null }]) {
      await expect(asendiaBrowser(trawl([locked, refusal]), number, signal, 5000, '00000'))
        .resolves.toMatchObject({ status: 'delivered', summary_only: true, events: [] });
    }
    // Scans captured without a supplied postcode are not this lookup's answer.
    await expect(asendiaBrowser(trawl([locked, entry(scans, true)]), number, signal, 5000))
      .resolves.toMatchObject({ summary_only: true });
    expect(urls.at(-1)).toBe(`https://track.asendia.com/track/${number}`);
  });
});
