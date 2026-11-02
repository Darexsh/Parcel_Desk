import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { isRecord } from '../../core/types.js';
import { createTracker } from '../../facade/index.js';
import { adapter, WINIT_API, WinitTracker } from './adapter.js';
import { normalizeWinitNumber, parseWinit, winitWording } from './parser.js';
import { statusMap, winitStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'WO00000000001A';
const IN_TRANSIT = 'WO0000000002A';
const UNKNOWN = 'WO0000000003A';

type Row = Record<string, unknown>;
type Shipment = Row & { trace: Row[] };
type Reply = Row & { data: Row & { all: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
// The shipment appears in its tab's list and in `all`; a change applies to both.
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  const shipment = reply.data.all[0] as Shipment;
  change(shipment, reply);
  for (const tab of ['sendPost', 'transportation', 'failed', 'haveSignedIn', 'exception']) {
    if (isRecord(reply.data) && Array.isArray(reply.data[tab]) && (reply.data[tab] as Row[]).length) reply.data[tab] = [shipment];
  }
  return reply;
};
const moved = (reply: Reply, tab: string, icon = `t-${tab}`) => {
  const shipment = reply.data.all[0] as Shipment;
  for (const name of ['sendPost', 'transportation', 'failed', 'haveSignedIn', 'exception']) reply.data[name] = name === tab ? [shipment] : [];
  shipment.statusIcon = icon;
  return reply;
};
const scan = (fields: Row): Row => ({ type: 'V', date: '2026-01-15 10:00:00', timeZone: 'Europe/Berlin', location: '', eventCode: 'I',
  eventStatus: null, eventDescription: 'Arrived at Facility', operator: null, ...fields });
// The lookup answers JSON with a comma in its content type.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json,charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('WINIT HTTP adapter', () => {
  it('posts the whole number in capitals as the page’s number list, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new WinitTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wo00000-00002 a ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(WINIT_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`trackingNoString=${IN_TRANSIT}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'winit', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('places a delivered history at the partner’s offsets and the warehouse’s zone, newest first, with the courier and its number', () => {
    const result = parseWinit(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-04-01T12:05:00-05:00', delivered_at: '2026-04-01T12:05:00-05:00', expected_delivery: null,
      delivery_carrier: 'fedex', delivery_tracking_number: '800000000013', destination_country: 'US' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.stage, event.provider_code, event.location, event.description])).toEqual([
      ['2026-04-01T12:05:00-05:00', 'delivered', undefined, 'Sample City,TX', 'Delivered'],
      ['2026-04-01T09:32:27-05:00', 'out_for_delivery', undefined, 'SAMPLE CITY,TX', 'On FedEx vehicle for delivery'],
      ['2026-04-01T06:12:00-05:00', 'in_transit', undefined, 'SAMPLE CITY,TX', 'At local FedEx facility'],
      ['2026-03-31T02:41:00-05:00', 'in_transit', undefined, 'SAMPLE HUB,TN', 'Departed FedEx hub'],
      // The warehouse is on New York's summer time.
      ['2026-03-30T17:14:26-04:00', 'accepted', 'DIC', 'USZZ1 Warehouse', 'Awaiting pickup'],
      ['2026-03-30T11:22:33-04:00', 'accepted', 'PAC', 'USZZ1 Warehouse', 'Item(s) packed'],
      ['2026-03-30T03:10:04-05:00', 'registered', undefined, undefined, 'Shipment information sent to FedEx'],
    ]);
    const text = JSON.stringify(result);
    for (const dropped of ['sample.staff01', 'system-oms', '"00000"', 'TN 00001', 'TX 00002', '"SAMPLE CITY"', '"WO00000000001"']) expect(text).not.toContain(dropped);
  });

  it('keeps the wall clocks of partner scans labelled with the warehouse’s zone, with the estimate and the courier', () => {
    const result = parseWinit(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at Facility',
      last_update: null, last_update_local: '2026-01-14T11:48:00', expected_delivery: '2026-01-16',
      delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10000000006', destination_country: 'FR' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.stage, event.provider_code, event.location])).toEqual([
      ['2026-01-14T11:48:00', 'in_transit', undefined, 'Sampleville'],
      ['2026-01-13T21:00:00', 'in_transit', undefined, 'Sampleburg'],
      ['2026-01-13T17:12:04', 'in_transit', undefined, 'Sampleburg'],
      ['2026-01-12T09:29:19+01:00', 'accepted', 'DIC', 'DEZZ1 Warehouse'],
      ['2026-01-12T07:24:09+01:00', 'accepted', 'PAC', 'DEZZ1 Warehouse'],
      ['2026-01-09T18:23:17', 'registered', undefined, undefined],
    ]);
    expect(result.events!.filter((event) => event.local_time).every((event) => event.time === undefined)).toBe(true);
    expect(result.events![5]!.description).toBe('Shipper created a label, UPS has not received the package yet.');
  });

  it('takes the tab’s word for a delivery, a failed attempt or an alert, unless a partner scan says the parcel waits or goes back', () => {
    const delivered = (newest: Row) => changed('delivered', (shipment) => { shipment.trace.push(scan(newest)); });
    expect(parseWinit(moved(changed('in-transit', () => undefined), 'haveSignedIn'), IN_TRANSIT))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(parseWinit(moved(changed('in-transit', () => undefined), 'failed'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    expect(parseWinit(moved(changed('in-transit', () => undefined), 'exception'), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    // The tracker files a parcel at a UPS Access Point under Delivered.
    expect(parseWinit(delivered({ date: '2026-04-02 09:00:00', eventDescription: 'Delivered to UPS Access Pointâ\u0084¢ ' }), DELIVERED))
      .toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Delivered to UPS Access Point™' });
    expect(parseWinit(moved(changed('in-transit', (shipment) => {
      shipment.trace.push(scan({ eventDescription: 'Returned to shipper' }));
    }), 'exception'), IN_TRANSIT)).toMatchObject({ current_stage: 'returned' });
    // In Transit, an untracked service and a tab missing from the lists leave the stage to the scans; the icon still counts.
    expect(parseWinit(moved(changed('delivered', () => undefined), 'sendPost'), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    const iconOnly = moved(changed('in-transit', () => undefined), 'none', 't-failed');
    expect(parseWinit(iconOnly, IN_TRANSIT)).toMatchObject({ current_stage: 'failed_attempt' });
  });

  it('reads an explicit offset, places only a warehouse clock that names an instant, and rejects an impossible clock', () => {
    const clocks = (row: Row) => parseWinit(changed('in-transit', (shipment) => { shipment.trace.push(row); }), IN_TRANSIT).events![0];
    expect(clocks(scan({ timeZone: 'GMT+08:00' }))).toMatchObject({ time: '2026-01-15T10:00:00+08:00' });
    expect(clocks(scan({ timeZone: 'UTC-3:30' }))).toMatchObject({ time: '2026-01-15T10:00:00-03:30' });
    expect(clocks(scan({ type: 'S', eventCode: 'PAC', timeZone: 'Australia/Sydney' }))).toMatchObject({ time: '2026-01-15T10:00:00+11:00' });
    // The hour Berlin skips for summer time names no instant; an unknown zone names none either.
    expect(clocks(scan({ type: 'S', eventCode: 'PAC', date: '2026-03-29 02:30:00' }))).toEqual(expect.objectContaining({ local_time: '2026-03-29T02:30:00' }));
    expect(clocks(scan({ type: 'S', eventCode: 'PAC', timeZone: 'Mars/Base' }))).toEqual(expect.objectContaining({ local_time: '2026-01-15T10:00:00' }));
    expect(clocks(scan({ timeZone: 'GMT+25:00' }))).toEqual(expect.objectContaining({ local_time: '2026-01-15T10:00:00' }));
    for (const date of ['2026-02-30 10:00:00', '2026-01-15 24:00:00', '2026-01-15T10:00:00Z', '', null]) {
      expect(() => clocks(scan({ date })), String(date)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps the wording without the person who signed, phone numbers or e-mail addresses, and puts misread UTF-8 right', () => {
    expect(winitWording({ eventDescription: 'Delivered, signed by SAMPLE PERSON' })).toBe('Delivered');
    expect(winitWording({ eventDescription: 'Call +1 (555) 000-0000 or sample@example.com to rebook.' })).toBe('Call or to rebook.');
    expect(winitWording({ eventDescription: '<b>UPS Access Pointâ\u0084¢ possession</b> ' })).toBe('UPS Access Point™ possession');
    expect(winitWording({ eventDescription: 'Ã©tape' })).toBe('étape');
    expect(winitWording({ eventDescription: 'Ã' })).toBe('Ã');
    expect(winitWording({ eventDescription: '', eventStatus: '打包完成' })).toBe('打包完成');
    // A scan without any wording is no scan.
    const result = parseWinit(changed('in-transit', (shipment) => { shipment.trace.push(scan({ eventDescription: ' ', eventStatus: null })); }), IN_TRANSIT);
    expect(result.events).toHaveLength(6);
  });

  it('names the courier only when the reply does and the number fits it, and never for an untracked service', () => {
    const handoff = (change: (shipment: Shipment) => void) => {
      const result = parseWinit(changed('in-transit', change), IN_TRANSIT);
      return { carrier: result.delivery_carrier, number: result.delivery_tracking_number };
    };
    expect(handoff((shipment) => { shipment.carrierCode = 'DE Sample Courier'; shipment.trackingUrl = 'https://courier.example/'; }))
      .toEqual({ carrier: undefined, number: '1Z999AA10000000006' });
    expect(handoff((shipment) => { shipment.carrierCode = 'Fedex'; shipment.trackingUrl = 'https://www.fedex.com/'; }))
      .toEqual({ carrier: undefined, number: '1Z999AA10000000006' });
    expect(handoff((shipment) => { shipment.carrierCode = 'US USPS'; shipment.trackingUrl = 'https://www.usps.com/';
      shipment.trackingNo = '420123459400111000001234567804'; })).toEqual({ carrier: 'usps', number: '9400111000001234567804' });
    expect(handoff((shipment) => { shipment.isTracked = 'N'; })).toEqual({ carrier: undefined, number: undefined });
    expect(handoff((shipment) => { shipment.trackingNo = IN_TRANSIT; })).toEqual({ carrier: undefined, number: undefined });
    expect(handoff((shipment) => { shipment.trackingNo = ''; })).toEqual({ carrier: undefined, number: undefined });
  });

  it('reads an unknown number as not found, a shipment without scans as no history, and a failed lookup as inconclusive', () => {
    expect(() => parseWinit(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWinit(changed('in-transit', (shipment) => { shipment.trace = []; }), IN_TRANSIT)).toThrow(NoHistoryError);
    expect(() => parseWinit(changed('in-transit', (shipment) => { shipment.trace = null as never; }), IN_TRANSIT)).toThrow(NoHistoryError);
    expect(() => parseWinit({ status: 0, info: 'The field[trackingNos] can not null', data: '' }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when its own package or order number is the one asked, and one parcel only', () => {
    // The order number finds its single package.
    expect(parseWinit(fixture('in-transit'), 'WO0000000002')).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseWinit(fixture('not-found'), 'WO0000000004A')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWinit(fixture('in-transit'), 'WO0000000002B')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twoPackages = changed('in-transit', (_shipment, body) => {
      body.data.all.push({ ...body.data.all[0], orderNo: 'WO0000000002B', trackingNo: '1Z999AA10000000015' });
    });
    expect(() => parseWinit(twoPackages, 'WO0000000002')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(parseWinit(twoPackages, IN_TRANSIT)).toMatchObject({ delivery_tracking_number: '1Z999AA10000000006' });
    // A not-found line for another number beside the shipment changes nothing.
    const withUnknown = changed('in-transit', (_shipment, body) => { body.data.all.push({ unfindNo: UNKNOWN, findNoBl: 'N' }); });
    expect(parseWinit(withUnknown, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { body.status = '1'; },
      (_shipment: Shipment, body: Reply) => { body.data = [] as never; },
      (_shipment: Shipment, body: Reply) => { body.data.all = {} as never; },
      (_shipment: Shipment, body: Reply) => { body.data.all = [null as never]; },
      (_shipment: Shipment, body: Reply) => { body.data.all = Array.from({ length: 501 }, () => ({ unfindNo: UNKNOWN, findNoBl: 'N' })); },
      (shipment: Shipment) => { shipment.trace = {} as never; },
      (shipment: Shipment) => { shipment.trace = [null as never]; },
      (shipment: Shipment) => { shipment.trace = Array.from({ length: 501 }, () => scan({})); },
      (shipment: Shipment) => { shipment.orderNo = ['WO0000000002A'] as never; },
      (shipment: Shipment) => { shipment.trace[0]!.eventDescription = { text: 'Delivered' }; },
      (shipment: Shipment) => { shipment.trace[0]!.location = ['Sampleburg']; },
    ]) {
      expect(() => parseWinit(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseWinit(null, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans and says the history is cut', () => {
    const result = parseWinit(changed('in-transit', (shipment) => {
      shipment.trace = Array.from({ length: 120 }, (_, index) => scan({ date: `2026-01-15 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}` }));
    }), IN_TRANSIT);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-01-15T10:01:59' });
  });

  it('keeps an unknown number, a moved route, a refusal, a firewall page and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://track.winit.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>418</title></html>', { status: 418 })).rejects.toMatchObject({ kind: 'challenge' });
    // Huawei Cloud's firewall can answer HTTP 200 with its page.
    await expect(lookup('<html><head><title>Sample</title><script src="/HWWAF-challenge.js"></script></head></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>系统发生错误</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${JSON.stringify(fixture('not-found'))}`)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number WINIT’s tracker does not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('in-transit'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-01T17:05:00.000Z' });
    // The newest scans' wall clocks cannot date the parcel's last activity; the warehouse's can.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-12T08:29:19.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1Z999AA10000000006')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers WINIT’s tracker does not take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1Z999AA10000000006', '800000000013', 'WO000000001A', 'WO000000000000001', 'WO0000000002ABC', 'ID0000000000000CN',
      'XO0000000002A', `WO${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeWinitNumber('wo 0000-0000-02a')).toBe(IN_TRANSIT);
    for (const number of ['WO0000000002', 'WO00000000001', 'WO00000000000001AU', 'ID00000000000000CN']) expect(normalizeWinitNumber(number)).toBe(number);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under WINIT, or detected as one of its package numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'winit' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'winit', source: 'winit', result: { current_stage: 'delivered', delivery_tracking_number: '800000000013' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'winit', source: 'winit' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === WINIT_API)).toBe(true);
  });
});

describe('WINIT numbers', () => {
  it('claims package numbers and leaves the partners’ numbers with their carriers', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, 'WO99999999999Z']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'winit', confidence: 'high' });
    }
    expect(detectCarrierMatch('1Z999AA10000000006').candidates).toContain('ups');
    expect(detectCarrierMatch('800000000013').candidates).toContain('fedex');
    for (const number of ['1Z999AA10000000006', '800000000013', 'WO000000001A', 'WO000000000001A']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('winit');
    }
  });
});

describe('WINIT status vocabulary', () => {
  it('records every code and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
        expect(winitStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
        continue;
      }
      expect(winitStage(null, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // The warehouse waits for the courier; a courier's own wording is the recipient's wait.
    expect(winitStage('DIC', 'Awaiting pickup')?.stage).toBe('accepted');
    expect(winitStage(null, 'Awaiting pickup')?.stage).toBe('ready_for_pickup');
    expect(statusMapAnswer({ carrier: 'winit', providerCode: 'PAC', description: '打包完成' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'winit', providerCode: null, description: 'Enroute to Carrier’s Depot to be shipped via [Sample Post]' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(winitStage(null, 'Synthetic note')).toBeNull();
  });
});
