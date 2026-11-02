import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult, type CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { adapter, CainiaoTracker, fetchCainiao, parseCainiaoTrackingResponse } from './adapter.js';
import { CAINIAO_ACTION_STATUS, CAINIAO_NOTICE_ACTIONS, CAINIAO_STATUS, cainiaoActionStage, cainiaoStageByStatus, statusMap } from './status.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { locatePlace } from '../../places/index.js';

const folder = path.dirname(fileURLToPath(import.meta.url));
const carrier = JSON.parse(
  readFileSync(path.join(folder, 'carrier.json'), 'utf8'),
) as { capabilities: string[] };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(folder, 'fixtures', name), 'utf8'));
}

const CAINIAO_WRONG_NUMBER = 'LP00000000000000';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cainiao wrong-number handling', () => {
  it('recognizes LP references through matching HTTP activity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture('delivered.json')));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('LP00000000000001', { budgetMs: 1000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:15:00.000Z' });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('mailNos')).toBe('LP00000000000001');
    await expect(instance.recognize!('not a parcel')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not recognize empty internal pending modules or hide wrong identities', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ module: [{ mailNo: CAINIAO_WRONG_NUMBER, mailNoSource: 'INTERNAL', detailList: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ module: [{ mailNo: 'LP11111111111111', detailList: [] }] }));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(CAINIAO_WRONG_NUMBER, { budgetMs: 1000 })).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(instance.recognize!(CAINIAO_WRONG_NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'schema' });
  });
  it('maps a matching empty external module to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'EXTERNAL',
        detailList: [],
        privateMessage: 'Private upstream details',
      }],
      success: true,
    }));

    try {
      await fetchCainiao(CAINIAO_WRONG_NUMBER);
      throw new Error('Expected the lookup to fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'NotFoundError', status: 404, kind: 'not_found' });
      expect(String(error)).toContain('Cainiao could not locate the shipment');
      expect(String(error)).not.toContain('Private upstream details');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get('mailNos')).toBe(CAINIAO_WRONG_NUMBER);
  });

  it('keeps a matching non-external empty shipment pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'INTERNAL',
        detailList: [],
      }],
      success: true,
    }));

    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).resolves.toMatchObject({
      status: 'pending',
      last_status_text: '',
      events: [],
    });
  });

  it('rejects a response describing a different shipment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{ mailNo: 'LP11111111111111', detailList: [] }],
      success: true,
    }));

    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).rejects.toThrow('different shipment');
  });

  it('reports the slider page Cainiao serves in place of the JSON as a challenge', async () => {
    const page = '<!DOCTYPE html>\n<html><head><script src="//example.invalid/punish/qrcode.js"></script></head>'
      + '<body><punish-component />\n<script>window._config_ = { "action": "captcha", "PATH": "/global/detail.json" };</script>'
      + '\n<!--rgv587_flag:sm-->\n</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page, { headers: { 'Content-Type': 'text/html' } }));
    await expect(new CainiaoTracker({ fetcher }).fetch(CAINIAO_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'ChallengeError', kind: 'challenge', provider: 'Cainiao',
    });
    // Any other page is still no tracking response, and JSON is read even when its wording names the flag.
    fetcher.mockResolvedValueOnce(new Response('<!DOCTYPE html><html><body>Maintenance</body></html>'));
    await expect(new CainiaoTracker({ fetcher }).fetch(CAINIAO_WRONG_NUMBER)).rejects.not.toMatchObject({ kind: 'challenge' });
    fetcher.mockResolvedValueOnce(jsonResponse({ module: [{ mailNo: CAINIAO_WRONG_NUMBER, mailNoSource: 'INTERNAL',
      detailList: [], statusDesc: '<!--rgv587_flag:sm-->' }] }));
    await expect(new CainiaoTracker({ fetcher }).fetch(CAINIAO_WRONG_NUMBER)).resolves.toMatchObject({ status: 'pending' });
  });

  it('uses the environment fetcher the factory hands the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      module: [{ mailNo: CAINIAO_WRONG_NUMBER, mailNoSource: 'INTERNAL', detailList: [] }],
    }));
    const global = vi.spyOn(globalThis, 'fetch');

    await expect(new CainiaoTracker({ fetcher }).fetch(CAINIAO_WRONG_NUMBER))
      .resolves.toMatchObject({ status: 'pending' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('Cainiao Express home-delivery numbers', () => {
  const HOME_DELIVERY = 'DOFR0000000000003HD';
  const empty = (mailNoSource: string, mailNo = HOME_DELIVERY) => jsonResponse({ data: [{ mailNo, mailNoSource, detailList: [] }], success: true });
  const endpoint = (call: Parameters<typeof fetch> | undefined) => {
    const url = new URL(String(call?.[0]));
    return `${url.origin}${url.pathname}`;
  };

  it('asks Cainiao Express for a partner\'s parcel that AliExpress\'s feed does not know', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(empty('EXTERNAL'))
      .mockResolvedValueOnce(jsonResponse(fixture('express-in-transit.json')));
    const result = await new CainiaoTracker({ fetcher }).fetch(HOME_DELIVERY);
    expect(fetcher.mock.calls.map(endpoint)).toEqual([
      'https://global.cainiao.com/global/detail.json',
      'https://track.cainiao.com/coe/trace/queryDetail',
    ]);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Referer')).toBe('https://global.cainiao.com/newDetail.htm');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(new URL(String(url)).searchParams.get('mailNos')).toBe(HOME_DELIVERY);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('Referer')).toBe('https://track.cainiao.com/orderTrack');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Transfer Departure',
      last_update: '2026-04-08T15:20:00+02:00', destination_country_name: 'France',
    });
    expect(result.delivery_tracking_number).toBeUndefined();
    // Its `location` field gives the town; a country code alone is no place.
    expect(result.events?.map((event) => [event.time, event.location, event.provider_code])).toEqual([
      ['2026-04-08T15:20:00+02:00', '', 'TRANSFER_DEPART'],
      ['2026-04-08T11:05:12+02:00', 'Exampleville', 'SC_SORTING'],
      ['2026-04-08T08:40:30+02:00', 'Exampleville', 'SC_INBOUND'],
      ['2026-04-08T03:10:00+02:00', 'Sample Hub', 'SC_OUTBOUND'],
      ['2026-04-07T13:45:00+02:00', 'Sample Hub', 'SC_INBOUND'],
    ]);
  });

  it("stages a partner's parcel on its way to Cainiao Express", () => {
    const history = [
      ['IN_TRANSIT_FR', 'Shipment is in transit to Cainiao Express', 'in_transit'],
      ['PARTNER_OUTBOUND_FR', "Shipment has left Cainiao Express's partner facility", 'in_transit'],
      ['LABEL_CREATED', 'Shipment data information received', 'registered'],
    ] as const;
    const detailList = history.map(([actionCode, desc], index) => ({ actionCode, desc, timeStr: `2026-04-0${7 - index} 10:00:00`, timeZone: 'GMT+2' }));
    const result = parseCainiaoTrackingResponse({ data: [{ mailNo: HOME_DELIVERY, latestTrace: detailList[0], detailList }] }, HOME_DELIVERY);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual(history.map(([code, , stage]) => [code, stage]));
    const registered = parseCainiaoTrackingResponse({ data: [{ mailNo: HOME_DELIVERY, latestTrace: detailList[2], detailList: [detailList[2]] }] }, HOME_DELIVERY);
    expect(registered).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('reads a home-delivery number neither feed knows as inconclusive, not missing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(empty('EXTERNAL')).mockResolvedValueOnce(empty('EXTERNAL'));
    await expect(new CainiaoTracker({ fetcher }).fetch(HOME_DELIVERY)).rejects.toMatchObject({
      name: 'IndeterminateError', kind: 'indeterminate', reason: 'portal_not_found', provider: 'Cainiao',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('asks only AliExpress\'s feed when it answers, and for any other number', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(fixture('delivered-dofr.json')))
      .mockResolvedValueOnce(empty('INTERNAL', 'DOFR0000000000001HD'))
      .mockResolvedValueOnce(empty('EXTERNAL', CAINIAO_WRONG_NUMBER));
    const tracker = new CainiaoTracker({ fetcher });
    await expect(tracker.fetch('DOFR0000000000001HD')).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.fetch('DOFR0000000000001HD')).resolves.toMatchObject({ status: 'pending' });
    await expect(tracker.fetch(CAINIAO_WRONG_NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(endpoint)).toEqual(Array(3).fill('https://global.cainiao.com/global/detail.json'));
  });

  it('keeps either feed\'s slider and a stranger\'s module from reading as an answer', async () => {
    const slider = () => new Response('<!DOCTYPE html><html><body><punish-component />\n<!--rgv587_flag:sm-->\n</body></html>',
      { headers: { 'Content-Type': 'text/html' } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(slider())
      .mockResolvedValueOnce(empty('EXTERNAL'))
      .mockResolvedValueOnce(slider())
      .mockResolvedValueOnce(empty('EXTERNAL'))
      .mockResolvedValueOnce(empty('EXTERNAL', 'DOFR0000000000004HD'));
    const tracker = new CainiaoTracker({ fetcher });
    await expect(tracker.fetch(HOME_DELIVERY)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.fetch(HOME_DELIVERY)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.fetch(HOME_DELIVERY)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

describe('Cainiao projection', () => {
  it('names the shape of a reply without shipment entries, not its contents', () => {
    expect(() => parseCainiaoTrackingResponse({ success: false, errorCode: 'SYSTEM_BUSY', errorMsg: 'Query LP00000000000001 later', extra: { mailNo: 'LP00000000000001' } }, 'LP00000000000001'))
      .toThrow('Cainiao returned an invalid tracking response: {success:boolean "false", errorCode:string "SYSTEM_BUSY", errorMsg:string "Query # later", extra:object}');
    expect(() => parseCainiaoTrackingResponse('<html></html>', 'LP00000000000001')).toThrow('invalid tracking response: string');
  });

  const delivered = parseCainiaoTrackingResponse(fixture('delivered.json'), 'LP00000000000001');
  const inTransit = parseCainiaoTrackingResponse(fixture('in-transit.json'), 'LP00000000000002');

  it('keeps the whole delivered journey and the partner handoff number', () => {
    expect(delivered).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-03-04T10:15:00+01:00',
      // A delivered parcel has no estimate left to show.
      expected_delivery: null,
      delivered_at: '2026-03-04T10:15:00+01:00',
      delivery_tracking_number: 'RA123456785CH',
    });
    expect(delivered.events?.map((event) => [event.description, event.stage])).toEqual([
      ['Delivered', 'delivered'],
      ['Out for delivery', 'out_for_delivery'],
      ['Import customs clearance success', 'in_transit'],
      ['Shipment accepted by the warehouse', 'registered'],
    ]);
  });

  it('keeps the origin scans of a journey longer than twenty events through normalization', () => {
    const intermediate = Array.from({ length: 23 }, (_, index) => ({
      actionCode: 'LH_ARRIVE', standerdDesc: `Transit scan ${index + 1}`,
    }));
    const latest = { actionCode: 'GTMS_SIGNED', standerdDesc: 'Delivered' };
    const origin = { actionCode: 'GWMS_ACCEPT', standerdDesc: 'Shipment accepted by the warehouse' };
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', latestTrace: latest, detailList: [latest, ...intermediate, origin],
    }] }, 'LP00000000000001'));
    expect(result.events).toHaveLength(25);
    expect(result.events?.at(-1)).toMatchObject({
      provider_code: 'GWMS_ACCEPT', description: 'Shipment accepted by the warehouse', stage: 'registered',
    });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('reads the town Cainiao writes before a scan\'s wording as its location', () => {
    expect(delivered.events?.map((event) => [event.location, event.description])).toEqual([
      ['Exampleville', 'Delivered'],
      ['Example City', 'Out for delivery'],
      ['', 'Import customs clearance success'],
      ['', 'Shipment accepted by the warehouse'],
    ]);
    const scan = (standerdDesc: string, carrier = 'Example Post') => parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', destCpInfo: { cpName: carrier },
      latestTrace: { actionCode: 'GTMS_ACCEPT', standerdDesc }, detailList: [{ actionCode: 'GTMS_ACCEPT', standerdDesc }],
    }] }, 'LP00000000000001');
    expect(scan("[Saint-Étienne-d'Exemple] Received by local delivery company")).toMatchObject({
      last_status_text: 'Received by local delivery company',
      events: [{ location: "Saint-Étienne-d'Exemple", description: 'Received by local delivery company' }],
    });
    // A bracket can name the country first. The town follows with it, and there a town in capitals counts.
    expect(scan('[USA,EXAMPLE CITY] Arrived at local delivery center').events?.[0])
      .toMatchObject({ location: 'EXAMPLE CITY, USA', description: 'Arrived at local delivery center' });
    expect(scan('[ES,Exampleville 99999] Received by local delivery company').events?.[0])
      .toMatchObject({ location: 'Exampleville 99999, ES', description: 'Received by local delivery company' });
    // A US town can come with its state and ZIP code, a town in capitals too.
    expect(scan('[Example City, CA 00000] Arrived at destination country/region sorting center').events?.[0])
      .toMatchObject({ location: 'Example City, CA 00000', description: 'Arrived at destination country/region sorting center' });
    expect(scan('[EXAMPLE CITY, TX 00000] Arrived').events?.[0]).toMatchObject({ location: 'EXAMPLE CITY, TX 00000', description: 'Arrived' });
    // A code a state shares is written out: CA is Canada there, not California.
    expect(scan('[CA,Exampleville] Arrived').events?.[0]).toMatchObject({ location: 'Exampleville, Canada', description: 'Arrived' });
    // A town keeps its postcode, and a country alone is the place, its postcode put first.
    expect(scan('[Exampleville 99999] Package delivered').events?.[0]).toMatchObject({ location: 'Exampleville 99999', description: 'Package delivered' });
    expect(scan('[ES] Out for delivery').events?.[0]).toMatchObject({ location: 'ES', description: 'Out for delivery' });
    expect(scan('[FR] Arrived').events?.[0]).toMatchObject({ location: 'France', description: 'Arrived' });
    expect(scan('[Spain 99999] Arrived at pick-up point').events?.[0])
      .toMatchObject({ location: '99999, Spain', description: 'Arrived at pick-up point' });
    // Other codes, abbreviations, carrier names, numbers and a bracket alone are no place.
    for (const wording of ['[Fr] Arrived', '[GOFO] Arrived', '[Example Post] Arrived', '[Post(NL)] Arrived',
      '[Hub 12] Arrived', '[Hub 123456] Arrived', '[EXAMPLEVILLE 99999] Arrived', '[Exampleville]', 'Arrived [Exampleville]',
      '[USA,GOFO] Arrived', '[USA,Example Post] Arrived', '[Exampleville,Example City] Arrived',
      '[Exampleville, ZZ 00000] Arrived', '[Example Post, CA 00000] Arrived', '[Exampleville, CA 0000] Arrived', '[GOFO, CA 00000] Arrived']) {
      expect(scan(wording).events?.[0]).toMatchObject({ location: '', description: wording });
      expect(scan(wording).last_status_text).toBe(wording);
    }
  });

  it('words a step whose standard wording is the "Carrier update" placeholder with its own', () => {
    const scan = (standerdDesc: string, desc: string) => parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', latestTrace: { actionCode: 'SC_TRANS_OUTBOUND_SUCCESS', standerdDesc, desc },
      detailList: [{ actionCode: 'SC_TRANS_OUTBOUND_SUCCESS', standerdDesc, desc }],
    }] }, 'LP00000000000001');
    expect(scan('Carrier update', '[Example City] Package left sorting center of transit')).toMatchObject({
      last_status_text: 'Package left sorting center of transit',
      events: [{ location: 'Example City', description: 'Package left sorting center of transit', provider_code: 'SC_TRANS_OUTBOUND_SUCCESS' }],
    });
    expect(scan('Carrier update', '').events?.[0]?.description).toBe('Carrier update');
    // Any other standard wording stays ahead of the scan's own.
    expect(scan('Departed from sorting center', 'Package left sorting center of transit').events?.[0]?.description)
      .toBe('Departed from sorting center');
  });

  it('reads each scan at its own GMT offset and ignores the Beijing-based epoch', () => {
    // The fixture's epoch `time` values read timeStr as GMT+8, as the live API does.
    expect(delivered.events?.map((event) => event.time)).toEqual([
      '2026-03-04T10:15:00+01:00', '2026-03-04T07:02:00+01:00', '2026-03-02T19:40:00+01:00', '2026-02-25T09:00:00+08:00',
    ]);
    const scan = (timeZone?: string) => parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: { actionCode: 'LH_ARRIVE', timeStr: '2026-06-10 07:40:00', timeZone, time: 1781048400000 }, detailList: [],
    }] }, 'LP00000000000001').last_update;
    expect(scan('GMT+5:30')).toBe('2026-06-10T07:40:00+05:30');
    expect(scan('GMT-5')).toBe('2026-06-10T07:40:00-05:00');
    expect(scan('GMT')).toBe('2026-06-10T07:40:00Z');
    // Without a zone the wall clock stays text rather than becoming the epoch's instant.
    expect(scan(undefined)).toBe('2026-06-10 07:40:00');
  });

  it('reads a zone-less notice that Cainiao recorded itself on the Beijing clock', () => {
    const scan = (timeStr: string, time: unknown, timeZone?: string) => ({ actionCode: 'LAST_MILE_ASN_NOTIFY', timeStr, time, timeZone });
    const departed = { actionCode: 'SC_OUTBOUND_SUCCESS', timeStr: '2026-06-10 07:39:39', timeZone: 'GMT+8', time: 1781048379000 };
    // The notice's epoch keeps milliseconds and renders to its timeStr in Beijing.
    const notice = scan('2026-06-10 07:40:16', 1781048416947, '');
    const result = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: notice, detailList: [notice, departed],
    }] }, 'LP00000000000001');
    expect(result.last_update).toBe('2026-06-10T07:40:16+08:00');
    expect(result.events?.map((event) => event.time)).toEqual(['2026-06-10T07:40:16+08:00', '2026-06-10T07:39:39+08:00']);
    const time = (latestTrace: unknown) => parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace, detailList: [],
    }] }, 'LP00000000000001').last_update;
    expect(time(scan('2026-06-10 07:40:16', 1781048416947))).toBe('2026-06-10T07:40:16+08:00');
    // A whole-second epoch can be a reading of the text, and one that disagrees with it is no record of it.
    expect(time(scan('2026-06-10 07:40:16', 1781048416000, ''))).toBe('2026-06-10 07:40:16');
    expect(time(scan('2026-06-10 01:40:16', 1781048416947, ''))).toBe('2026-06-10 01:40:16');
    expect(time(scan('2026-06-10 07:40:16', '1781048416947', ''))).toBe('2026-06-10 07:40:16');
    // A zone the adapter cannot read is still a zone: it is not replaced by Beijing's.
    expect(time(scan('2026-06-10 07:40:16', 1781048416947, 'CET'))).toBe('2026-06-10 07:40:16');
  });

  it("keeps the stage of the scan before Cainiao's notice to the last-mile courier, the parcel at its newest scan", () => {
    const scan = (actionCode: string, timeStr: string, desc = '', standerdDesc = 'Carrier update') => ({ actionCode, timeStr, timeZone: 'GMT+8', desc, standerdDesc });
    const departed = scan('SC_OUTBOUND_SUCCESS', '2026-06-10 07:39:39', '', 'Departed from sorting center');
    const forecast = scan('LAST_MILE_ASN_NOTIFY', '2026-06-10 07:40:16', 'Last-mile delivery forecast');
    const result = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: forecast, detailList: [forecast, departed],
    }] }, 'LP00000000000001');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Last-mile delivery forecast',
      last_update: '2026-06-10T07:40:16+08:00' });
    expect(result.events?.map((event) => [event.provider_code, event.description, event.stage])).toEqual([
      ['LAST_MILE_ASN_NOTIFY', 'Last-mile delivery forecast', 'in_transit'],
      ['SC_OUTBOUND_SUCCESS', 'Departed from sorting center', 'in_transit'],
    ]);
    expect(result.events?.[0]).toMatchObject({ stage_source: 'none' });
    expect(result.events?.[1]).not.toHaveProperty('stage_source');
    // Worded only by the placeholder, after export customs started, it leaves the parcel in customs.
    const placeholder = scan('LAST_MILE_ASN_NOTIFY', '2026-06-10 09:00:00');
    const customs = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: placeholder, detailList: [placeholder, scan('CC_EX_START', '2026-06-10 08:00:00', '', 'Export customs clearance started'), departed],
    }] }, 'LP00000000000001');
    expect(customs).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Carrier update' });
    expect(customs.events?.[0]).toMatchObject({ stage: 'customs', stage_source: 'none' });
    // Before any scan, a notice leaves the parcel pending.
    const alone = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001', latestTrace: placeholder, detailList: [placeholder] }] }, 'LP00000000000001');
    expect(alone.events?.[0]).toMatchObject({ stage: 'pending', stage_source: 'none' });
  });

  it('keeps a flight out dated at midnight as its day', () => {
    const scan = (actionCode: string, timeStr: string) => ({ actionCode, timeStr, timeZone: 'GMT+8', time: 1781020800000 });
    const leaving = scan('LH_HO_AIRLINE', '2026-06-10 00:00:00');
    const result = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: leaving,
      detailList: [leaving, scan('LH_DEPART', '2026-06-10 00:00:00'), scan('CC_EX_SUCCESS', '2026-06-09 00:00:00'), scan('LH_HO_IN_SUCCESS', '2026-06-08 09:48:49')],
    }] }, 'LP00000000000001');
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-06-10', '2026-06-10', '2026-06-09T00:00:00+08:00', '2026-06-08T09:48:49+08:00',
    ]);
    expect(result.events?.[0]?.time).toBeUndefined();
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-10' });
    // A flight with a time keeps it.
    const timed = scan('LH_DEPART', '2026-06-10 05:57:00');
    expect(parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001', latestTrace: timed, detailList: [timed] }] },
      'LP00000000000001').events?.[0]).toMatchObject({ time: '2026-06-10T05:57:00+08:00' });
  });

  it.each(['ra 123.456-785 ch', 'RA123456785CH'])('normalizes the machine-readable partner reference before host validation: %s', (reference) => {
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      copyRealMailNo: reference, latestTrace: { actionCode: 'LH_ARRIVE' }, detailList: [],
    }] }, 'LP00000000000001'));
    expect(result.delivery_tracking_number).toBe('RA123456785CH');
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('uses display prose only when the machine-readable reference is invalid', () => {
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      copyRealMailNo: 'bad?number', realMailNo: 'Handover reference: ra123456785ch', detailList: [],
    }] }, 'LP00000000000001'));
    expect(result.delivery_tracking_number).toBe('RA123456785CH');
  });

  it('reports the estimate as a window while the parcel is still moving', () => {
    expect(inTransit).toMatchObject({
      status: 'in_transit',
      current_stage: 'in_transit',
      expected_delivery: '2026-03-12',
      expected_delivery_from: '2026-03-10',
    });
  });

  it('never reads a station signature as a delivery', () => {
    const result = parseCainiaoTrackingResponse({
      module: [{
        mailNo: 'LP00000000000003',
        latestTrace: { actionCode: 'GTMS_STA_SIGNED', standerdDesc: 'Arrived at the pickup station' },
        detailList: [{ actionCode: 'GTMS_STA_SIGNED', standerdDesc: 'Arrived at the pickup station' }],
      }],
    }, 'LP00000000000003');

    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(result.events?.[0]?.stage).toBe('ready_for_pickup');
  });

  it('keeps each milestone stable as the parcel moves from customs to collection', () => {
    const journey = [
      ['PU_PICKUP_SUCCESS', 'Received by logistics company', 'accepted'],
      ['CC_EX_START', 'Export customs clearance started', 'customs'],
      ['CC_EX_SUCCESS', 'Export customs clearance complete', 'in_transit'],
      ['CC_HO_IN_SUCCESS', 'Arrived at customs', 'customs'],
      ['CC_IM_START', 'Import customs clearance started', 'customs'],
      ['CC_IM_SUCCESS', 'Import customs clearance complete', 'in_transit'],
      ['GTMS_ACCEPT', 'Received by local delivery company', 'in_transit'],
      ['GTMS_RELABEL', 'Tracking number changed', 'in_transit'],
      ['GTMS_DO_ARRIVE', 'Arrived at local delivery center', 'in_transit'],
      ['GTMS_STATION_OUT', 'Delivery in process. Now left facility.', 'in_transit'],
      ['GTMS_DO_DEPART', 'Out for delivery', 'out_for_delivery'],
      ['GTMS_STA_SIGNED', 'Arrived at pick-up point. Package available for collection.', 'ready_for_pickup'],
      ['GTMS_SIGNED', 'Package delivered', 'delivered'],
    ] as const;
    for (let index = 0; index < journey.length; index++) {
      const history = journey.slice(0, index + 1).reverse();
      const scans = history.map(([actionCode, standerdDesc]) => ({ actionCode, standerdDesc }));
      const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
        mailNo: 'LP00000000000001', latestTrace: scans[0], detailList: scans,
      }] }, 'LP00000000000001'));
      expect(result.current_stage).toBe(journey[index]![2]);
      expect(result.events?.map((event) => event.stage)).toEqual(history.map((row) => row[2]));
      for (const [code, wording, stage] of history) {
        expect(statusMap.stage(code, wording.toLowerCase())).toBe(stage);
      }
    }
  });

  it('places a numbered arrondissement while leaving facility codes and named carriers alone', () => {
    const project = (place: string, cpName = 'Example Post') => normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', destCpInfo: { cpName }, latestTrace: { actionCode: 'GTMS_SIGNED' },
      detailList: [{ actionCode: 'GTMS_SIGNED', standerdDesc: `[${place}] Package delivered` }],
    }] }, 'LP00000000000001'));
    const event = project('PARIS 12E ARRONDISSEMENT').events?.[0];
    expect(event).toMatchObject({ location: 'PARIS 12E ARRONDISSEMENT', description: 'Package delivered' });
    expect(locatePlace(event!.location, { countries: ['FR'] })).toMatchObject({ country: 'FR', precision: 'city' });
    for (const place of ['HUB 12', 'PARIS 75012', 'GOFO', 'PARIS 99E ARRONDISSEMENT']) {
      expect(project(place).events?.[0]?.location).toBeUndefined();
    }
    expect(project('PARIS 12E ARRONDISSEMENT', 'PARIS 12E ARRONDISSEMENT').events?.[0]?.location).toBeUndefined();
  });

  it.each(['LP00000000000001', 'lp 00000000000001'])('does not advertise the queried number as a handoff: %s', (copyRealMailNo) => {
    expect(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', copyRealMailNo, detailList: [],
    }] }, 'LP00000000000001')).not.toHaveProperty('delivery_tracking_number');
  });

  it('names no partner for a number of Cainiao’s own, so an Ecoscooting reference hands over to Ecoscooting', () => {
    const reference = 'CNPRT00000001234000000001';
    const result = parseCainiaoTrackingResponse({ module: [{
      mailNo: reference, copyRealMailNo: 'CNG12345678901234', destCountry: 'Portugal', latestTrace: { actionCode: 'LH_ARRIVE' }, detailList: [],
    }] }, reference);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(deliveryHandoff('aliexpress', reference, result)).toEqual({ carrier: 'ecoscooting', number: reference, basis: 'reference' });
  });

  it('stages the legs between the linehaul and the local partner, and keeps every action code', () => {
    const scans = [
      ['GTMS_SC_DEPART', '[Exampleville] Departed from destination country/region sorting center'],
      ['TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office'],
      ['TD_TRANSWH_OUTBOUND', 'Leaving transit country/region'],
      ['LH_HO_OUT_SUCCESS', 'Handed over from linehaul office'],
      ['NEW_UNSEEN_CODE', 'Synthetic scan'],
    ];
    const reply = (detailList: Array<{ actionCode: string; standerdDesc: string }>) => parseCainiaoTrackingResponse({
      module: [{ mailNo: 'LP00000000000004', latestTrace: detailList[0], detailList }],
    }, 'LP00000000000004');
    const result = reply(scans.map(([actionCode, standerdDesc]) => ({ actionCode: actionCode!, standerdDesc: standerdDesc! })));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events?.map((event) => [event.provider_code, event.description, event.stage])).toEqual([
      ['GTMS_SC_DEPART', 'Departed from destination country/region sorting center', 'in_transit'],
      ['TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office', 'in_transit'],
      ['TD_TRANSWH_OUTBOUND', 'Leaving transit country/region', 'in_transit'],
      ['LH_HO_OUT_SUCCESS', 'Handed over from linehaul office', 'in_transit'],
      // An unknown code stays without a stage, and its code goes to review with the wording.
      ['NEW_UNSEEN_CODE', 'Synthetic scan', undefined],
    ]);
    expect(reply([{ actionCode: '', standerdDesc: 'Synthetic scan' }]).events?.[0]).not.toHaveProperty('provider_code');
  });

  it("stages the consolidation warehouse's sign-in in transit, like its departure", () => {
    const signIn = { actionCode: 'CW_SIGN_IN_SUCCESS', standerdDesc: 'Arrived at warehouse' };
    const result = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000007', latestTrace: signIn, detailList: [signIn] }] },
      'LP00000000000007');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'CW_SIGN_IN_SUCCESS', stage: 'in_transit' });
  });

  it('reads a failed delivery attempt as one, newest or not', () => {
    const reply = (detailList: Array<{ actionCode: string; standerdDesc: string }>) => parseCainiaoTrackingResponse({
      module: [{ mailNo: 'LP00000000000005', latestTrace: detailList[0], detailList }],
    }, 'LP00000000000005');
    const failed = { actionCode: 'GTMS_DEL_FAILURE', standerdDesc: 'Delivery attempt failed' };
    const outForDelivery = { actionCode: 'GTMS_DO_DEPART', standerdDesc: 'Out for delivery' };
    const latest = reply([failed, outForDelivery]);
    expect(latest).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(latest.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['GTMS_DEL_FAILURE', 'failed_attempt'],
      ['GTMS_DO_DEPART', 'out_for_delivery'],
    ]);
    const retried = reply([{ actionCode: 'GTMS_SIGNED', standerdDesc: 'Delivered' }, failed, outForDelivery]);
    expect(retried).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(retried.events?.[1]).toMatchObject({ provider_code: 'GTMS_DEL_FAILURE', stage: 'failed_attempt' });
  });

  const journey = (codes: string[]) => parseCainiaoTrackingResponse({ module: [{
    mailNo: 'LP00000000000005',
    latestTrace: { actionCode: codes[0], standerdDesc: 'Newest scan' },
    detailList: codes.map((actionCode, index) => ({ actionCode, standerdDesc: `Scan ${codes.length - index}` })),
  }] }, 'LP00000000000005');

  it('reads the delivery and return codes of local partners and pickup points', () => {
    // A partner accepting the parcel after the hand-off moves it along, and a sorting delay is no fault.
    expect(journey(['LM_SIGN_SUCCESS', 'LM_DELIVERY_DEPART', 'TRANSFER_ARRIVE', 'SC_OUTBOUND', 'TRANSFER_DEPART',
      'SC_SORTING', 'SC_OUTBOUND_FAILURE', 'SL_ACCEPT', 'SC_INBOUND']).events?.map((event) => event.stage)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
    ]);
    expect(journey(['GTMS_DEL_FAILURE', 'GTMS_DO_DEPART'])).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    // A pickup point that would not take the parcel in is a failed attempt; one that signed for it holds it for the recipient.
    const atPoint = journey(['PUDO_DELIVERY', 'PUDO_DELIVERY_FAILURE', 'LM_DELIVERY_DEPART']);
    expect(atPoint).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(atPoint.events?.map((event) => event.stage)).toEqual(['ready_for_pickup', 'failed_attempt', 'out_for_delivery']);
    expect(journey(['PUDO_DELIVERY_FAILURE', 'LM_DELIVERY_DEPART'])).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    // A pickup point's own delivery scan is the recipient collecting the parcel.
    const collected = journey(['GTMS_SIGNED', 'GSTA_SIGN', 'GSTA_INBOUND', 'SC_HO_OUT_SUCCESS', 'GTMS_SC_ARRIVE']);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(collected.events?.map((event) => event.stage)).toEqual([
      'delivered', 'delivered', 'ready_for_pickup', 'in_transit', 'in_transit',
    ]);
    const returned = journey(['RT_INBOUND', 'GTMS_SIGN_FAILURE', 'GTMS_DEL_FAILURE', 'GTMS_DO_DEPART', 'TD_TRANS_ARRIVE_DCP',
      'GTMS_STATION_OUT', 'GTMS_DO_ARRIVE']);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(returned.events?.map((event) => event.stage)).toEqual([
      'returned', 'exception', 'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit',
    ]);
  });

  it('reads a sorting center turning the parcel away as a fault, not an acceptance', () => {
    const refused = journey(['SC_INBOUND_FAILURE', 'PU_PICKUP_SUCCESS']);
    expect(refused).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(refused.events?.map((event) => event.stage)).toEqual(['exception', 'accepted']);
  });

  it('reads an order the seller is still preparing, before any scan, as registered', () => {
    const preparing = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000005', status: 'SELLER_PREPARING', detailList: [] }] },
      'LP00000000000005');
    expect(preparing).toMatchObject({ status: 'pending', current_stage: 'registered', events: [] });
  });

  it('claims no stage for an order token it does not know before any scan', () => {
    const unread = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000006', status: 'SELLER_SOMETHING_NEW', detailList: [] }] },
      'LP00000000000006');
    expect(unread).toMatchObject({ status: 'unknown', last_status_text: 'SELLER_SOMETHING_NEW', events: [] });
    expect(unread.current_stage).toBeUndefined();
  });

  it('files every recorded code under the stage statuses.json gives it', () => {
    const recorded = JSON.parse(readFileSync(path.join(folder, 'statuses.json'), 'utf8')) as {
      entries: Array<{ code: string; wording?: string; stage?: string }>;
    };
    for (const entry of recorded.entries) {
      if (!entry.stage) {
        expect(CAINIAO_NOTICE_ACTIONS.has(entry.code), entry.code).toBe(true);
        expect(statusMapAnswer({ carrier: 'aliexpress', providerCode: entry.code, description: entry.wording ?? '' }).kind, entry.code).toBe('intentional_gap');
        continue;
      }
      const token = CAINIAO_STATUS.get(entry.code);
      // Parcel-level tokens stage a reply without action codes; the map answers action codes.
      const stage = token ? cainiaoStageByStatus()[token] : statusMap.stage(entry.code, normalizeStatusWording(entry.wording ?? 'Synthetic scan'));
      expect(stage, entry.code).toBe(entry.stage);
    }
    for (const code of CAINIAO_ACTION_STATUS.keys()) {
      expect(recorded.entries.find((entry) => entry.code === code)?.stage, code).toBe(cainiaoActionStage(code));
    }
  });

  it('reads the destination country without the town Cainiao can add after it', () => {
    const destination = (destCountry: string) => parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', destCountry, latestTrace: { actionCode: 'LH_ARRIVE' }, detailList: [],
    }] }, 'LP00000000000001').destination_country_name;
    expect(destination('France,Sampletown')).toBe('France');
    expect(destination(' Germany ')).toBe('Germany');
    expect(destination(',Sampletown')).toBeUndefined();
  });
});

describe('Cainiao declared capabilities and privacy', () => {
  const results: CarrierResult[] = [
    parseCainiaoTrackingResponse(fixture('delivered.json'), 'LP00000000000001'),
    parseCainiaoTrackingResponse(fixture('in-transit.json'), 'LP00000000000002'),
  ];
  const checks: Record<string, (result: CarrierResult) => boolean> = {
    history: (result) => (result.events?.length ?? 0) > 0,
    location: (result) => (result.events ?? []).some((event) => Boolean(event.location)),
    eta: (result) => Boolean(result.expected_delivery),
    eta_window: (result) => Boolean(result.expected_delivery_from),
    sender_name: (result) => Boolean(result.sender_name),
    pickup_point: (result) => Boolean(result.pickup_point),
    weight: (result) => result.weight_kg != null,
    dimensions: (result) => Boolean(result.dimensions_text),
    delivered_at: (result) => Boolean(result.delivered_at),
    provider_code: (result) => (result.events ?? []).some((event) => Boolean(event.provider_code)),
  };

  it.each(carrier.capabilities)('declares %s and a fixture proves it', (capability) => {
    const check = checks[capability];
    expect(check, `unknown capability ${capability}`).toBeTypeOf('function');
    expect(results.some((result) => check!(result))).toBe(true);
  });

  it('drops the recipient identity the module carries', () => {
    const projected = JSON.stringify(results[0]);
    for (const value of ['Made Up Recipient', 'Example Street 1', 'proof-of-delivery', 'signPictureUrl']) {
      expect(projected).not.toContain(value);
    }
  });
});
