import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeOmgoNumber, parseOmgoNonce, parseOmgoTrackingJson } from './parser.js';
import { omgoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'OMGO0000000000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const payload = () => JSON.parse(fixture('tracking.json'));
const parse = (value: unknown) => parseOmgoTrackingJson(JSON.stringify(value), NUMBER);

describe('OMGO tracking parser', () => {
  it('binds the whole shipment and retains local scan clocks and carrier milestones', () => {
    const result = parseOmgoTrackingJson(fixture('tracking.json'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      destination_country: 'CA', service_name: 'OMGO Express', last_update: null, last_update_local: '2026-01-05T10:45' });
    expect(result.events!.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered']);
    expect(result.events!.every(event => !event.time && event.local_time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC-INVOICE');
    expect(JSON.stringify(result)).not.toContain('shi-status');
  });

  it('keeps generic negative and empty history inconclusive', () => {
    expect(() => parseOmgoTrackingJson(fixture('unknown.json'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parse({ success: false, data: {} })).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    const empty = payload(); empty.data.tracking_data[0].trackHistory = [];
    expect(() => parse(empty)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    expect(() => parse({ success: true, data: { total_found: 0, tracking_data: [] } }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it.each([
    (value: ReturnType<typeof payload>) => { value.data.tracking_data[0].trackingNumber = `X${NUMBER}`; },
    (value: ReturnType<typeof payload>) => { value.data.found[0] = `${NUMBER}1`; },
    (value: ReturnType<typeof payload>) => { value.data.tracking_data[0].trackingNumber = {}; },
    (value: ReturnType<typeof payload>) => { value.data.tracking_data.push(value.data.tracking_data[0]); },
    (value: ReturnType<typeof payload>) => { value.data.not_found.push(NUMBER); },
    (value: ReturnType<typeof payload>) => { value.data.total_found = 2; },
    (value: ReturnType<typeof payload>) => { value.data.tracking_data[0].trackHistory[0].message = {}; },
    (value: ReturnType<typeof payload>) => { value.data.tracking_data[0].trackHistory[0].location = {}; },
    (value: ReturnType<typeof payload>) => { value.data.tracking_data[0].trackHistory[0].time = {}; },
  ])('rejects wrong identities, conflicting counts and invalid public fields', mutate => {
    const value = payload(); mutate(value);
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('preserves valid explicit offsets and impossible dates as unresolved text', () => {
    const value = payload();
    const scans = value.data.tracking_data[0].trackHistory;
    scans[0].time = '2026-01-05 10:45:30-05:00';
    scans[1].time = '2026-02-30 14:20';
    scans[2].time = '2026-01-03 17:00+99:00';
    const result = parse(value);
    expect(result.events![0]).toMatchObject({ time: '2026-01-05T10:45:30-05:00' });
    expect(result.events![1]).toMatchObject({ provider_time_text: '2026-02-30 14:20' });
    expect(result.events![2]).toMatchObject({ provider_time_text: '2026-01-03 17:00+99:00' });
    expect(result.events![1]!.time).toBeUndefined();
    expect(result.events![2]!.time).toBeUndefined();
  });

  it('retains upstream order when clocks differ between facilities and deduplicates only identical scans', () => {
    const value = payload();
    const scans = value.data.tracking_data[0].trackHistory;
    scans[0].time = '2026-01-03 01:00'; scans[1].time = '2026-01-03 12:00';
    scans.push({ ...scans[0] }); scans.push({ ...scans[0], location: 'Another terminal' });
    const result = parse(value);
    expect(result.events![0]!.local_time).toBe('2026-01-03T01:00');
    expect(result.events![1]!.local_time).toBe('2026-01-03T12:00');
    expect(result.events).toHaveLength(8);
  });

  it('marks capped histories and rejects excessive upstream histories', () => {
    const value = payload();
    value.data.tracking_data[0].trackHistory = Array.from({ length: 101 }, (_, index) => ({ message: 'Arrived at Terminal Location', location: `Synthetic facility ${index}`, time: '' }));
    expect(parse(value)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parse(value).events).toHaveLength(100);
    value.data.tracking_data[0].trackHistory = Array.from({ length: 501 }, () => ({ message: 'Loaded on Truck', location: '', time: '' }));
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps new unknown wording neutral and preserves real wording classification provenance', () => {
    const value = payload(); value.data.tracking_data[0].trackHistory[0].message = 'New unrecognized observation';
    value.data.tracking_data[0].trackHistory[1].message = 'Out for delivery';
    expect(parse(value)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });
    expect(parse(value).events![0]).toMatchObject({ stage: 'pending', stage_source: 'none' });
  });

  it.each(statuses.entries)('maps the observed wording $wording', entry => {
    expect(omgoStage(entry.wording)).toBe(entry.stage);
  });

  it('rejects malformed JSON and blocked HTML distinctly', () => {
    expect(() => parseOmgoTrackingJson('{', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOmgoTrackingJson('<html><title>Just a moment...</title></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

describe('OMGO page configuration', () => {
  it('reads its synthetic nonce and normalizes only the supported identifier', () => {
    expect(parseOmgoNonce(fixture('tracking-page.html'))).toBe('aabbccddee');
    expect(normalizeOmgoNumber('omgo 0000000000001')).toBe(NUMBER);
    expect(() => normalizeOmgoNumber(`X${NUMBER}`)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it.each([
    '<html>Empty tracking page</html>',
    'var shiAjax = {"ajax_url":"https://another.invalid/","nonce":"aabbccddee"};',
    'var shiAjax = {"ajax_url":"https://omgoexpress.cn/wp-admin/admin-ajax.php","nonce":{}};',
    'var shiAjax = {"ajax_url":"https://omgoexpress.cn/wp-admin/admin-ajax.php","nonce":"invalid"};',
    'var shiAjax = {};' + 'var shiAjax = {};',
  ])('rejects invalid or ambiguous bootstrap without executing scripts', html => {
    expect(() => parseOmgoNonce(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
