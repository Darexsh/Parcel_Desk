import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeKolayGelsinNumber, parseKolayGelsin } from './parser.js';
import { kolayGelsinStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '260731593842';
const OTHER = '260648295173';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const page = (data = fixture()) => `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
const shipment = (data: ReturnType<typeof fixture>) => data.props.pageProps.shipmentDetails;

describe('Kolay Gelsin guest milestone parser', () => {
  it('binds the whole number and keeps reached milestones with the carrier’s precise stated offsets', () => {
    const result = parseKolayGelsin(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Teslim ettik', last_update: '2026-09-16T17:45:22.987+03:00', expected_delivery: null });
    expect(result.events).toEqual([
      { time: '2026-09-16T17:45:22.987+03:00', description: 'Teslim ettik', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-09-16T11:35:00', description: 'Teslimata Çıkardık', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-09-16T07:10:00', description: 'Yolda', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-14T16:50:00', description: 'Teslim aldık', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-09-14T10:15:37.123+03:00', description: 'Gönderi Talebi Alındı', stage: 'registered', stage_source: 'carrier_map' },
    ]);
  });

  it('discards all personal, courier, coordinate, note, capability and tracking-query fields', () => {
    const result = JSON.stringify(parseKolayGelsin(page(), NUMBER));
    for (const forbidden of [NUMBER, 'Synthetic', 'SYNTHETIC', 'Private', 'Invented', 'recipient@example.invalid', '40.123', '29.123', 'Recipient', 'Sender', 'Courier', 'Signatory', 'qid', 'query', 'hashLink']) {
      expect(result, forbidden).not.toContain(forbidden);
    }
  });

  it.each(['TrackingNumber', 'query.q', 'pageProps.q'])('rejects another whole identity in %s', field => {
    const data = fixture();
    if (field === 'TrackingNumber') shipment(data).TrackingNumber = OTHER;
    if (field === 'query.q') data.query.q = OTHER;
    if (field === 'pageProps.q') data.props.pageProps.q = OTHER;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('never compares a capped identity or rounds an unsafe numeric identity', () => {
    const data = fixture();
    shipment(data).TrackingNumber = NUMBER + ' '.repeat(70) + OTHER;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    shipment(data).TrackingNumber = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects another frontend route and ambiguous query values', () => {
    const data = fixture();
    data.page = '/another-page';
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    data.page = '/tracking';
    data.query.q = [NUMBER, OTHER];
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['IsOtpRequired', 'IsReturnShipment'])('does not guess recipient verification or an unverified return journey (%s)', field => {
    const data = fixture(); shipment(data)[field] = true;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['IsOtpRequired', 'IsReturnShipment'])('rejects changed flag types (%s)', field => {
    const data = fixture(); shipment(data)[field] = 'true';
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not complete one related parcel from another parcel’s milestones', () => {
    const data = fixture(); shipment(data).RelatedTrackingIds = [NUMBER, OTHER];
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('ignores inactive or undated future rail steps even when the summary names delivery', () => {
    const data = fixture();
    shipment(data).Statuses[4].Date = '31.12.2050 17:45';
    shipment(data).Statuses[4].Active = false;
    let result = parseKolayGelsin(page(data), NUMBER);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: null, last_update_local: '2026-09-16T11:35:00' });
    expect(result.events).toHaveLength(4);
    shipment(data).Statuses[4].Active = true;
    shipment(data).Statuses[4].Date = '';
    result = parseKolayGelsin(page(data), NUMBER);
    expect(result.current_stage).toBe('out_for_delivery');
    expect(result.events).toHaveLength(4);
  });

  it('does not manufacture activity from a state-only or empty shipment', () => {
    const data = fixture(); shipment(data).Statuses = [];
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    data.props.pageProps.shipmentDetails = null;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps each reached milestone once and retains an unknown wording without inventing progress', () => {
    const data = fixture(); shipment(data).Statuses.push({ ...shipment(data).Statuses[2] });
    expect(parseKolayGelsin(page(data), NUMBER).events).toHaveLength(5);
    shipment(data).Statuses[4].Message = 'Ara durum kaydı';
    const result = parseKolayGelsin(page(data), NUMBER);
    expect(result.events![0]).toEqual({ local_time: '2026-09-16T17:45:00', description: 'Ara durum kaydı' });
    expect(result.current_stage).toBe('out_for_delivery');
  });

  it('keeps a failed attempt separate from the word delivered and does not reuse DeliveryDate for it', () => {
    const data = fixture(); shipment(data).Statuses[4].Message = 'teslim edilemedi';
    const result = parseKolayGelsin(page(data), NUMBER);
    expect(result.current_stage).toBe('failed_attempt');
    expect(result.events![0]).toMatchObject({ local_time: '2026-09-16T17:45:00', stage: 'failed_attempt' });
    expect(result.events![0]!.time).toBeUndefined();
  });

  it('preserves a stated offset instead of substituting the catalogue zone', () => {
    const data = fixture(); shipment(data).DeliveryDate = '2026-09-16T17:45:22.987+04:00';
    expect(parseKolayGelsin(page(data), NUMBER).last_update).toBe('2026-09-16T17:45:22.987+04:00');
  });

  it('leaves a milestone local when a summary timestamp does not identify the same wall minute', () => {
    const data = fixture(); shipment(data).DeliveryDate = '2026-09-16T16:45:22.987+03:00';
    expect(parseKolayGelsin(page(data), NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-09-16T17:45:00' });
  });

  it.each(['30.02.2026 17:45', '16.09.2026 24:00', '2026-09-16 17:45', 123])('rejects an invalid reached clock %s', date => {
    const data = fixture(); shipment(data).Statuses[4].Date = date;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-02-30T17:45:22+03:00', '2026-09-16T24:00:00+03:00', '2026-09-16T17:45:22+02:99', '2026-09-16T17:45:22'])('rejects malformed summary timestamps %s', date => {
    const data = fixture(); shipment(data).DeliveryDate = date;
    expect(() => parseKolayGelsin(page(data), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(statuses.entries)('agrees with recorded wording $wording', entry => {
    expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
  });

  it('normalizes only supported shared numeric shapes without claiming carrier ownership', () => {
    expect(normalizeKolayGelsinNumber('26 0731-593842')).toBe(NUMBER);
    expect(normalizeKolayGelsinNumber(NUMBER + '17')).toBe(NUMBER + '17');
    for (const value of ['1234', NUMBER + '1', 'AB0731593', NUMBER + OTHER]) {
      expect(() => normalizeKolayGelsinNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(kolayGelsinStage('TESLİM ALDIK')).toEqual({ stage: 'accepted', source: 'carrier_map' });
  });

  it('does not read an HTTP200 browser wall or arbitrary HTML as a missing parcel', () => {
    expect(() => parseKolayGelsin('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseKolayGelsin('<html>Unavailable</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
