import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PacticTracker, pacticTrackingUrl } from './adapter.js';
import { isPacticWaybill, normalizePacticNumber, parsePactic } from './parser.js';
import { pacticWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// C, four digits, the creation time 2026-03-02 09:15:12 and six digits.
const WAYBILL = 'C0001260302091512000017';
const UNKNOWN = 'C0001260302091512000099';
// Partner couriers' numbers Pactic books and its tracker also answers.
const GLS = '00200000017';
const DPD = '16400000000017';
const SAMEDAY = '1SYN00000000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Row = { status: unknown; date: unknown; waybills?: unknown };
type Item = Record<string, unknown> & { statusList: { history: Row[] } & Record<string, unknown> };
const delivered = () => JSON.parse(text('delivered.json')) as Item[];
const edited = (change: (item: Item, reply: Item[]) => void) => {
  const reply = delivered();
  change(reply[0]!, reply);
  return reply;
};
/** The same parcel booked on a partner courier, asked by the courier's number. */
const booked = (number: string, link: string) => edited((item) => {
  item.waybill = number;
  item.carrierUrl = link;
  item.carrierType = 24;
  for (const row of item.statusList.history) row.waybills = [number];
});

describe('Pactic numbers', () => {
  const offers = (number: string) => {
    const match = detectCarrierMatch(number);
    return [match.carrier, ...(match.candidates ?? [])];
  };

  it('names Pactic for C, four digits, the creation time and six digits', () => {
    expect(detectCarrierMatch(WAYBILL)).toMatchObject({ carrier: 'pactic', confidence: 'high' });
    expect(detectCarrierMatch(WAYBILL.toLowerCase())).toMatchObject({ carrier: 'pactic', confidence: 'high' });
    expect(detectCarrierMatch('C9999991231235959999999')).toMatchObject({ carrier: 'pactic', confidence: 'high' });
    for (const other of [
      'C000126030209151200001', 'C00012603020915120000170', 'D0001260302091512000017', '00001260302091512000017',
      // Month 13, day 00 and 32, hour 24, minute 60, second 60.
      'C0001261302091512000017', 'C0001260300091512000017', 'C0001260332091512000017', 'C0001260302241512000017',
      'C0001260302096012000017', 'C0001260302091560000017',
    ]) {
      expect(offers(other), other).not.toContain('pactic');
    }
  });

  it('leaves the partner couriers’ numbers its tracker also answers to their couriers', () => {
    for (const number of [GLS, DPD, SAMEDAY]) {
      expect(offers(number), number).not.toContain('pactic');
      expect(isPacticWaybill(number), number).toBe(false);
    }
    expect(isPacticWaybill(` ${WAYBILL.toLowerCase()} `)).toBe(true);
  });

  it('reads a link to the tracking page, and leaves a partner’s number in it to detection', () => {
    expect(parseTrackingInput(`https://dashboard.pactic.com/tracking?waybill=${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'pactic' });
    expect(parseTrackingInput(`https://dashboard.pactic.com/en/tracking?waybillNumber=${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'pactic' });
    expect(parseTrackingInput(`https://dashboard.pactic.com/hu/csomagkovetes?waybillnumber=${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'pactic' });
    const partner = parseTrackingInput(`https://dashboard.pactic.com/tracking?waybill=${DPD}`);
    expect(partner.trackingNumber).toBe(DPD);
    expect(partner.carrier).not.toBe('pactic');
  });

  it('takes 17TRACK’s name and the platform’s former one', () => {
    for (const name of ['Pactic', 'PACTIC', 'Allpacka']) expect(carrierIdFromName(name), name).toBe('pactic');
  });
});

describe('Pactic HTTP adapter', () => {
  it('asks the tracking page’s lookup for the waybill', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PacticTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${WAYBILL.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://dashboard.pactic.com/api/Meta/tracking?waybill=${WAYBILL}`);
    expect(url).toBe(pacticTrackingUrl(WAYBILL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pactic', step: 'direct', outcome: 'ok' }));
  });

  it('reads the history newest first, on wall clocks with no zone, each status once', () => {
    const result = parsePactic(delivered(), WAYBILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-06T15:24:00', expected_delivery: null });
    expect(result.delivered_at).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage ?? null])).toEqual([
      ['2026-03-06T15:24:00', '4', 'Delivered', 'delivered'],
      ['2026-03-06T15:18:00', '30', 'Placed in Parcelshop/Parcel locker', 'ready_for_pickup'],
      ['2026-03-06T08:21:00', '3', 'Out for delivery', 'out_for_delivery'],
      ['2026-03-05T09:46:00', '41', 'Shipment arrived at the final logistics center', 'in_transit'],
      ['2026-03-05T02:09:00', '2', 'In transit', 'in_transit'],
      ['2026-03-04T18:39:00', '27', 'Shipment arrived to the sorting centre / in the sorting centre', 'in_transit'],
      ['2026-03-03T11:37:00', '40', 'Arrived at the logistics center in Poland', 'in_transit'],
      ['2026-03-03T10:32:00', '40', 'Arrived at the logistics center in Poland', 'in_transit'],
      ['2026-03-03T09:19:00', '26', 'Picked up by the driver', 'accepted'],
      ['2026-03-02T11:15:00', '1', 'Data processed', 'registered'],
      ['2026-03-02T09:15:00', '1', 'Data processed', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('reads the envelope an archived reply had, with its statuses out of order', () => {
    const result = parsePactic(JSON.parse(text('envelope.json')), WAYBILL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived To HUB',
      last_update_local: '2026-03-03T11:37:00' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code])).toEqual([
      ['2026-03-03T11:37:00', '101'], ['2026-03-03T10:32:00', '101'], ['2026-03-03T09:19:00', '26'],
      ['2026-03-02T11:15:00', '1'], ['2026-03-02T09:15:00', '1'],
    ]);
  });

  it('takes a waybill without the spaces and dashes a user can type in it', () => {
    expect(normalizePacticNumber(' c0001-2603 0209 1512-000017 ')).toBe(WAYBILL);
    expect(() => normalizePacticNumber('C0001')).toThrow('6 to 40');
    expect(() => normalizePacticNumber('C0001/260302')).toThrow('6 to 40');
  });

  it('words a status the page does not label by its code, without a stage', () => {
    expect(pacticWording('44')).toBe('Status 44');
    const result = parsePactic(edited((item) => {
      item.statusList.history.unshift({ status: '44', date: '2026.03.07. 10:00', waybills: [WAYBILL] });
    }), WAYBILL);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Status 44', last_update_local: '2026-03-07T10:00:00' });
    expect(result.events![0]).toEqual({ local_time: '2026-03-07T10:00:00', description: 'Status 44', provider_code: '44' });
  });

  it('keeps a status that moves nothing without a stage, under the movement before it', () => {
    const result = parsePactic(edited((item) => {
      item.statusList.history.splice(0, 3, { status: '16', date: '2026.03.06. 18:00', waybills: [WAYBILL] });
    }), WAYBILL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Rescheduled delivery' });
    expect(result.events![0]!.stage).toBeUndefined();
  });

  it('names the partner courier its link names, for the number asked', () => {
    expect(parsePactic(booked(SAMEDAY, `https://sameday.ro/#awb=${SAMEDAY}`), SAMEDAY))
      .toMatchObject({ status: 'delivered', delivery_carrier: 'sameday' });
    expect(parsePactic(booked(DPD, `https://tracking.dpd.de/parcelstatus?query=${DPD}&locale=en_HU`), DPD))
      .toMatchObject({ delivery_carrier: 'dpd-de' });
    expect(parsePactic(booked(DPD, `https://tracking.dpd.de/parcelstatus?query=${DPD}`), DPD).delivery_tracking_number).toBeUndefined();
    // GLS's group site tracks Hungarian parcels as GLS Germany's tracker does.
    expect(parsePactic(booked(GLS, `https://gls-group.eu/HU/en/parcel-tracking?match=${GLS}`), GLS))
      .toMatchObject({ delivery_carrier: 'gls-de' });
  });

  it('names the partner’s own number when the link names a waybill of the history other than the one asked', () => {
    const result = parsePactic(edited((item) => {
      item.carrierUrl = `https://sameday.ro/#awb=${SAMEDAY}`;
      item.statusList.history[0]!.waybills = [WAYBILL, SAMEDAY];
    }), WAYBILL);
    expect(result).toMatchObject({ delivery_carrier: 'sameday', delivery_tracking_number: SAMEDAY });
  });

  it('names no partner for a link without the parcel’s number, a link that names no one carrier, or no link', () => {
    for (const link of ['https://sameday.ro/', `https://sameday.ro/#awb=${SAMEDAY}0`, `https://gls-group.eu/track?match=${GLS}`,
      'javascript:void(0)', 'not a link']) {
      const number = link.includes('gls') ? GLS : SAMEDAY;
      expect(parsePactic(booked(number, link), number).delivery_carrier, link).toBeUndefined();
    }
  });

  it('reads the tracker’s empty list as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(replying(() => json({ status: 200, data: [], error: null }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps a refusal, a moved route, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [json({ title: 'One or more validation errors occurred.', status: 400, errors: { waybill: ['Invalid.'] } }, { status: 400 }), 'indeterminate'],
      [json('', { status: 404 }), 'transport'],
      [new Response('', { status: 308, headers: { Location: 'https://dashboard.pactic.com/' } }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>', { status: 403 }), 'challenge'],
      [json({ title: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': '42' } }), 'rate_limited'],
      [new Response('', { status: 500 }), 'indeterminate'],
      [new Response('', { status: 503 }), 'maintenance'],
      [new Response('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [new Response('<html><body>maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [json({ status: 500, data: null, error: 'Synthetic failure' }), 'indeterminate'],
      [json({ message: 'Synthetic' }), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: WAYBILL }), kind).rejects.toMatchObject({ kind });
    }
    await expect(carrier(replying(() => json({}, { status: 429, headers: { 'Retry-After': '42' } }))).track({ number: WAYBILL }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
  });

  it('leaves an answer for another parcel, several parcels, an empty history and a changed reply open or failed, never found', () => {
    expect(() => parsePactic(edited((item) => { item.waybill = UNKNOWN; }), WAYBILL)).toThrow('another parcel');
    expect(() => parsePactic(edited((item) => { item.waybill = `${WAYBILL}1`; }), WAYBILL)).toThrow('another parcel');
    expect(() => parsePactic(edited((item, reply) => { reply.push(structuredClone(item)); }), WAYBILL)).toThrow('several parcels');
    expect(() => parsePactic(edited((item) => { item.statusList.history = []; }), WAYBILL)).toThrow(NoHistoryError);
    for (const date of ['2026-03-02 09:15', '2026.02.30. 9:15', '2026.03.02. 24:00', '2026.03.02.', null]) {
      expect(() => parsePactic(edited((item) => { item.statusList.history[0]!.date = date; }), WAYBILL), String(date)).toThrow('invalid status time');
    }
    expect(() => parsePactic(edited((item) => { item.statusList.history[0]!.status = 'Delivered'; }), WAYBILL)).toThrow('invalid status code');
    expect(() => parsePactic(edited((item) => { delete (item as Record<string, unknown>).statusList; }), WAYBILL)).toThrow('invalid parcel');
    expect(() => parsePactic(edited((item) => { item.statusList.history = Array.from({ length: 501 }, () => item.statusList.history[0]!); }), WAYBILL))
      .toThrow('invalid history');
  });

  it('reads a status code the reply gives as a number, and a clock to the second', () => {
    const result = parsePactic(edited((item) => {
      item.statusList.history[0] = { status: 4, date: '2026.03.06. 15:24:45', waybills: [WAYBILL] };
    }), WAYBILL);
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-06T15:24:45', provider_code: '4', stage: 'delivered' });
  });

  it('recognizes only its own waybills, asking the tracker', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    await expect(carrier(fetcher).recognize!(WAYBILL)).resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-06T15:24:00' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const partner = replying(() => json(booked(SAMEDAY, `https://sameday.ro/#awb=${SAMEDAY}`)));
    for (const number of [SAMEDAY, GLS, DPD, 'C0001']) await expect(carrier(partner).recognize!(number), number).resolves.toEqual({ known: false });
    expect(partner).not.toHaveBeenCalled();
    await expect(carrier(replying(() => json('[]'))).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
  });

  it('still tracks a partner courier’s number when asked for Pactic', async () => {
    const fetcher = replying(() => json(booked(SAMEDAY, `https://sameday.ro/#awb=${SAMEDAY}`)));
    await expect(carrier(fetcher).track({ number: SAMEDAY })).resolves.toMatchObject({ status: 'delivered', delivery_carrier: 'sameday' });
    expect(fetcher.mock.calls[0]![0]).toBe(pacticTrackingUrl(SAMEDAY));
  });
});

describe('Pactic status map', () => {
  it('lists every status the page labels once, stages the ones that move the parcel, and the app reads it', () => {
    const codes = statuses.entries.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe('stage' in entry ? entry.stage : undefined);
      expect(pacticWording(entry.code)).toBe(entry.wording);
    }
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(statuses.entries.filter((entry) => !('stage' in entry)).map((entry) => entry.code));
    expect(statusMapAnswer({ carrier: 'pactic', providerCode: '40', description: 'Arrived at the logistics center in Poland' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pactic', providerCode: '115', description: 'Cash on Delivery transferred by Pactic' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
  });
});
