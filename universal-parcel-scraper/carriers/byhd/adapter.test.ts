import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { GZYL } from '../gzyl/parser.js';
import { THHY } from '../thhy/parser.js';
import { adapter, ByhdTracker } from './adapter.js';
import { BYHD, BYHD_ORIGIN, parseByhdPage } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'BYHD990000001';
const PARTNER = '9900000000000000000001';
const UNKNOWN = 'BYHD990000009';
// Noon in Beijing on 6 March, after the fixture's row.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The populated page, its form echoing `codes` instead. */
const echoing = (codes: string) => page('page').replace(`value='${NUMBER}\n'`, `value='${codes}\n'`);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BYHD numbers', () => {
  it('claims BYHD and nine digits, and nothing shorter, longer or under another prefix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'byhd', confidence: 'high', candidates: ['byhd'] });
    for (const other of ['BYHD99000000', 'BYHD9900000001', 'BYHX990000001', 'XBYHD990000001']) {
      expect(detectCarrierMatch(other).candidates, other).not.toContain('byhd');
    }
  });
});

describe('BYHD tracking adapter', () => {
  it('asks its own Hualei tracker over plain HTTP, then its page, which binds the order through the form’s echo', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page')));
    const result = await new ByhdTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', destination_country: 'CH' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${BYHD_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`, 'GET'],
      [`${BYHD_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(BYHD_ORIGIN).toBe('http://www.byhd56.com:8082');
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${NUMBER}`);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'byhd', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the platform’s own row on Beijing time, and the shown number as the delivery carrier’s', () => {
    const result = parseByhdPage(page('page'), NUMBER, READ_AT);
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'The electronic cargo information has been received', last_update: '2026-03-02T16:15:01+08:00',
      destination_country: 'CH', delivery_tracking_number: PARTNER,
    });
    expect(result.events).toEqual([{ time: '2026-03-02T16:15:01+08:00', description: 'The electronic cargo information has been received',
      stage: 'registered', stage_source: 'carrier_map' }]);
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'S0001-001', 'Synthetic Line']) expect(text, value).not.toContain(value);
  });

  it('takes the page’s record only for the one number its form echoes, and only on its own tenant', () => {
    for (const codes of ['BYHD990000002', `${NUMBER}\nBYHD990000002`, '']) {
      expect(() => parseByhdPage(echoing(codes), NUMBER, READ_AT), codes).toThrow(IndeterminateError);
    }
    // A reference or delivery number the page shows binds through its column, as on every tenant.
    expect(parseByhdPage(echoing('S0001-001'), 'S0001-001', READ_AT)).toMatchObject({ delivery_tracking_number: PARTNER });
    const asked = parseByhdPage(echoing(PARTNER), PARTNER, READ_AT);
    expect(asked).toMatchObject({ current_stage: 'registered' });
    expect(asked.canonical_tracking_number ?? asked.delivery_tracking_number).toBeUndefined();
    // The tenants whose pages show the number they found keep binding by those columns alone.
    for (const tenant of [GZYL, THHY]) expect(() => parseHualeiPage(page('page'), NUMBER, tenant, READ_AT)).toThrow(IndeterminateError);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseByhdPage(page('page-unknown'), 'BYHD990000008', READ_AT)).toThrow(IndeterminateError);
  });

  it('stages its receiving point and operation center scans by their wording, not their kind code', () => {
    const row = (track_date: string, track_kind: string, track_content: string) => ({ track_date, track_kind, track_content, track_location: '' });
    const result = parseHualeiTrack([{ ack: 'true', data: [{ business_seqinvoicecode: NUMBER, consigneeCountry: 'CH', trackDetails: [
      row('2026-03-05 18:00:00', 'SHIPMENT', 'Goods leaving the operation center'),
      row('2026-03-05 09:00:00', 'ARRIVAL', '到达收货点'),
    ] }] }], NUMBER, BYHD, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(result!.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['SHIPMENT', 'in_transit', 'carrier_map'], ['ARRIVAL', 'accepted', 'carrier_map']]);
    expect(statusMap.stage('ARRIVAL', 'synthetic arrival')).toBeUndefined();
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'byhd', providerCode: null, description: 'The electronic cargo information has been received' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'byhd', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
  });
});
