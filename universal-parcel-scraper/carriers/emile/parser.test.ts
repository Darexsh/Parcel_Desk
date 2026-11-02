import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { statusMapAnswer } from '../../app.js';
import { normalizeEmileNumber, parseEmileTrackingXml } from './parser.js';

const NUMBER = 'EM000000000001CA';
const OTHER = 'EM000000000002CA';
const fixture = () => readFileSync(new URL('./fixtures/delivered.xml', import.meta.url), 'utf8');
const negative = () => readFileSync(new URL('./fixtures/not-found.xml', import.meta.url), 'utf8');
const parse = (xml: string) => parseEmileTrackingXml(xml, NUMBER);

describe('Emile tracking XML', () => {
  it('binds a Canadian parcel, preserves scan offsets and separates operation codes from sequence numbers', () => {
    const result = normalizeCarrierResult(parse(fixture()));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'CA',
      last_update: '2026-01-03T11:00:00-05:00', delivered_at: '2026-01-03T11:00:00-05:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.map(event => event.provider_code)).toEqual(['40', '31', '30', '22', '21', '20', '10']);
    expect(result.events?.at(-1)).toMatchObject({ description: 'Waybill Generated', time: '2026-01-01T09:00:00Z', stage: 'registered' });
    expect(result.events?.[5]).toMatchObject({ location: 'Synthetic City, ON', stage: 'in_transit' });
    const serialized = JSON.stringify(result);
    for (const value of ['PRIVATE', 'proof.invalid', 'PX000000000001CN']) expect(serialized).not.toContain(value);
    expect(parse(fixture().replace('recipient_country="CA"', 'recipient_country="Canada"')).destination_country).toBe('CA');
  });

  it('recognizes only the exact observed negative signature, bound to the requested number', () => {
    expect(() => parse(negative())).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(negative().replace(NUMBER, OTHER))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(negative().replace('Order [EM000000000001CA] not found trackingevent.', 'Service unavailable')))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(`<root><status>0</status><tracks barcode="${NUMBER}"/></root>`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(negative().replace('<status>0', '<status>1'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects mismatching, absent and ambiguous shipment identity, without truncating it', () => {
    for (const xml of [fixture().replace(`barcode="${NUMBER}"`, `barcode="${OTHER}"`),
      fixture().replace(`barcode="${NUMBER}"`, ''), fixture().replace('</root>', `<tracks barcode="${NUMBER}"/></root>`),
      fixture().replace(`barcode="${NUMBER}"`, `barcode="${NUMBER}${' '.repeat(600)}${OTHER}"`),
      fixture().replace('recipient_country="CA"', 'recipient_country="US"')]) {
      expect(() => parse(xml)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects malformed XML, namespaces, duplicated or nested required scalars and excessive responses', () => {
    for (const xml of ['', '<html>Unavailable</html>', fixture().replace('</root>', ''),
      fixture().replace('<root>', '<root xmlns="urn:other">'), fixture().replace('<status>0</status>', '<status>0</status><status>0</status>'),
      fixture().replace('<status>0</status>', '<status><value>0</value></status>'), fixture().replace('<status>0</status>', '<status/>'),
      fixture().replace('<status_desc>DELIVERED</status_desc>', '<status_desc><value>DELIVERED</value></status_desc>'),
      fixture().replace('<status_desc>DELIVERED</status_desc>', '<status_desc/>'),
      `<!DOCTYPE root [<!ENTITY identity "${NUMBER}">]>${fixture()}`, fixture() + ' '.repeat(1_000_000)]) {
      expect(() => parse(xml)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parse('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script></html>'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each(['', 'GMT-05:99', 'GMT+99:00', 'EST'])('retains an unresolved local clock for %s', zone => {
    const result = parse(fixture().replaceAll('GMT-05:00', zone));
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-03T11:00:00' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-03T11:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it.each(['2026-02-30 11:00:00', '2026-01-03 24:00:00', 'broken'])('keeps invalid clock text %s without borrowing an earlier scan', time => {
    const result = parse(fixture().replace('2026-01-03 11:00:00', time));
    expect(result).toMatchObject({ last_update: null, last_update_local: null });
    expect(result.events?.[0]).toMatchObject({ provider_time_text: time });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps driver assignment in transit, distinguishes completed returns and leaves unknown wording open', () => {
    const change = (text: string) => parse(fixture().replace('<status_desc>DELIVERED</status_desc>', `<status_desc>${text}</status_desc>`));
    expect(change('TASK ASSIGNED')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    const returned = change('RETURNED TO SENDER');
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(returned).not.toHaveProperty('delivered_at');
    expect(change('Synthetic unknown scan').events?.[0]).not.toHaveProperty('stage');
    expect(change('EMAIL REMINDER SENT / FAILED')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'emile', providerCode: '40', description: 'RETURNED TO SENDER' })).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'emile', providerCode: null, description: 'WAYBILL_MODIFY_FEE' })).toEqual({ kind: 'mapped', stage: 'pending' });
  });

  it('deduplicates scans, marks capped histories partial and bounds the upstream scan count', () => {
    const xml = fixture(), scan = /<track><track_point_code>40[\s\S]*?<\/track>/.exec(xml)![0];
    expect(parse(xml.replace('</tracks>', `${scan}</tracks>`)).events).toHaveLength(7);
    const many = (length: number) => `<root><status>0</status><tracks barcode="${NUMBER}">${Array.from({ length }, (_, index) =>
      scan.replace('<status_desc>DELIVERED', `<status_desc>Synthetic scan ${index}`)).join('')}</tracks></root>`;
    expect(parse(many(101))).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parse(many(101)).events).toHaveLength(100);
    expect(() => parse(many(501))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts the Emile format and rejects postal EMS items and concatenated identifiers', () => {
    expect(normalizeEmileNumber('em 000000000001 ca')).toBe(NUMBER);
    // The longer barcodes Emile prints on parcels 4PX hands over.
    expect(normalizeEmileNumber('em 0000000000000001 ca')).toBe('EM0000000000000001CA');
    for (const input of ['EM000000001CA', 'EM000000000001US', 'EM000000000000001CA', 'EM00000000000000001CA', `${NUMBER}${OTHER}`, '<track/>']) {
      expect(() => normalizeEmileNumber(input)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});
