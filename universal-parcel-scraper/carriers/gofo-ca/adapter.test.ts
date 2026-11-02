import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter as gofoUs } from '../gofo/adapter.js';
import { GOFO_CANADA, normalizeGofoNumber, parseGofo } from '../gofo/parser.js';
import { adapter } from './adapter.js';

const NUMBER = 'GFCA00000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const item = (value: ReturnType<typeof fixture>) => value.data.success[0];
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const reply = (value: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(value)));

describe('GOFO Canada history', () => {
  it('reads the requested Toronto clocks in each scan\'s zone, without the support line', () => {
    const result = parseGofo(fixture(), NUMBER, GOFO_CANADA);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-01-04T12:00:00-05:00', delivered_at: '2026-01-04T12:00:00-05:00',
      destination_country: 'CA', service_name: 'CIRRO Parcel' });
    expect(result.events?.map(event => [event.time, event.description, event.stage])).toEqual([
      ['2026-01-04T12:00:00-05:00', 'Delivered', 'delivered'],
      ['2026-01-04T08:00:00-05:00', 'Out for Delivery', 'out_for_delivery'],
      ['2026-01-03T15:00:00-08:00', 'Arrived at GOFO Regional Hub', 'in_transit'],
      ['2026-01-01T12:00:00-05:00', 'Shipping Label Created', 'registered'],
    ]);
    const pacific = fixture(); item(pacific).trackEventList[1].processDate = '2026-01-04T05:00:00.000-0800';
    expect(() => parseGofo(pacific, NUMBER, GOFO_CANADA)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('proves absence only on the Canadian error list', () => {
    const negative = { success: 1, code: 200, data: { success: [], error: { errorCount: 1, ca: [NUMBER] } } };
    expect(() => parseGofo(negative, NUMBER, GOFO_CANADA)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGofo({ ...negative, data: { success: [], error: { errorCount: 1, us: [NUMBER] } } }, NUMBER, GOFO_CANADA))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('binds the waybill and refuses a reference naming another GOFO parcel', () => {
    for (const reference of ['GFCA00000000000002', 'GFUS00000000000001']) {
      const value = fixture(); item(value).trackingNumber = reference; for (const row of item(value).trackEventList) delete row.trackingNumber;
      expect(() => parseGofo(value, NUMBER, GOFO_CANADA)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const other = fixture(); item(other).waybillNo = 'GFCA00000000000002';
    expect(() => parseGofo(other, NUMBER, GOFO_CANADA)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('GOFO Canada retrieval', () => {
  it('asks the Canadian consignee service for Toronto clocks', async () => {
    const fetcher = reply(fixture());
    await adapter(environment(fetcher)).track({ number: 'gfca-000000 0000 0001' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://www.gofo.com/ca/cnee-api/consignee/track/query/page');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({ numberList: [NUMBER] });
    expect(new Headers(init?.headers).get('User-Time-Zone')).toBe('America/Toronto');
  });
  it('recognizes a waybill GOFO Canada answers, and none on its error list', async () => {
    expect(await adapter(environment(reply(fixture()))).recognize!(NUMBER)).toMatchObject({ known: true });
    const unknown = adapter(environment(reply({ success: 1, code: 200, data: { success: [], error: { errorCount: 1, ca: [NUMBER] } } })));
    expect(await unknown.recognize!(NUMBER)).toEqual({ known: false });
  });
  it('keeps the US and Canadian services to their own waybills', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(adapter(environment(unused)).track({ number: 'GFUS00000000000001' })).rejects.toThrow(InvalidInputError);
    await expect(gofoUs(environment(unused)).track({ number: NUMBER })).rejects.toThrow(InvalidInputError);
    expect(unused).not.toHaveBeenCalled();
    expect(() => normalizeGofoNumber('GFCA0000000000001', GOFO_CANADA)).toThrow(InvalidInputError);
  });
});

describe('GOFO Canada detection', () => {
  it('claims GFCA waybills and the Canadian tracker\'s links', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'gofo-ca', confidence: 'high' });
    expect(detectCarrierMatch('GFCA0000000000001').carrier).not.toBe('gofo-ca');
    expect(detectCarrierMatch('GFUS00000000000001').carrier).not.toBe('gofo-ca');
    expect(parseTrackingInput(`https://www.gofo.com/ca/track?searchID=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'gofo-ca', source: 'link' });
    expect(parseTrackingInput('https://www.gofo.com/us/track?searchID=GFUS00000000000001')).toMatchObject({ carrier: 'gofo', source: 'link' });
  });
});
