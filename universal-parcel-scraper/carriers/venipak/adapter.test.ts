import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { VENIPAK_ENDPOINT, VenipakTracker, adapter, venipakTrackingUrl } from './adapter.js';
import { normalizeVenipakNumber, normalizeVenipakParcelNumber, parseVenipak } from './parser.js';
import { venipakScanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const LOCKER = 'V00000E0000001';
const DOOR = 'V00000E0000002';
const REST = 'V00000E0000003';
const UNKNOWN = 'V00000E0000009';
const SHIPMENT = '100000002';
const fixture = (name: string): string => (JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as { parcels: string }).parcels;
const locker = fixture('locker');
const shipment = fixture('shipment');
const absent = fixture('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = locker) => {
  const $ = load(body, null, false);
  change($);
  return $.html();
};
const wrap = (parcels: string) => ({ parcels });
const row = (time: string, text: string) => `<div class="parcel-info" data-lat="0" data-lng="0" data-status="1"><div class="info-time">${time}</div>`
  + `<div class="info-place">${text}</div><div class="info-status-icon icon-1">1</div></div>`;
const history = (...rows: string[]) => edit($ => $(`#parcel-${LOCKER}`).html(rows.join('')));
const reply = (body: string | object = wrap(locker), status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Venipak direct tracking', () => {
  it('reads a locker delivery as wall clocks, with the locker it waited in', () => {
    const result = normalizeCarrierResult(parseVenipak(wrap(locker), LOCKER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-07-04T18:02:00', expected_delivery: null, pickup_point: 'Näidis Rimi Venipak pakiautomaat\nTartu' });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-07-04T18:02:00', 'Delivered', 'Näidis Rimi Venipak pakiautomaat, Tartu', 'delivered'],
      ['2026-07-03T11:20:00', 'Delivered to pickup point', 'Näidis Rimi Venipak pakiautomaat, Tartu', 'ready_for_pickup'],
      ['2026-07-03T06:45:00', 'Out for delivery', undefined, 'out_for_delivery'],
      ['2026-07-03T02:10:00', 'At terminal', undefined, 'in_transit'],
      ['2026-07-02T19:30:00', 'At terminal', 'TALLINN', 'in_transit'],
      ['2026-07-02T09:05:00', 'Picked up', undefined, 'accepted'],
      ['2026-07-01T17:40:00', 'Is placed for dispatch', 'Minta Keskus Venipak pakiautomaat', 'accepted'],
      ['2026-07-01T10:15:00', 'At sender', undefined, 'registered'],
    ]);
    expect(result.events?.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The scans' coordinates and the delivery explanation stay out.
    expect(JSON.stringify(result)).not.toMatch(/59\.1|24\.1|58\.4|26\.4|coordinates|lat|lng/i);
    const waiting = parseVenipak(wrap(edit($ => $('.parcel-info').last().remove())), LOCKER);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Näidis Rimi Venipak pakiautomaat\nTartu' });
  });

  it('picks the asked parcel out of its shipment and drops a repeated scan', () => {
    const door = normalizeCarrierResult(parseVenipak(wrap(shipment), DOOR));
    expect(door).toMatchObject({ status: 'delivered', last_update_local: '2026-09-02T12:41:00' });
    expect(door.pickup_point).toBeUndefined();
    expect(door.events?.map(event => [event.local_time, event.description, event.location])).toEqual([
      ['2026-09-02T12:41:00', 'Delivered', undefined],
      ['2026-09-02T08:00:00', 'Out for delivery', undefined],
      ['2026-09-01T18:10:00', 'At terminal', undefined],
      ['2026-09-01T14:30:00', 'Picked up', 'VILNIUS TM2'],
      ['2026-09-01T09:00:00', 'At sender', undefined],
    ]);
    const rest = edit($ => $('#searchQuery').attr('value', `searched by: ${REST}`), shipment);
    expect(parseVenipak(wrap(rest), REST)).toMatchObject({ status: 'in_transit', last_status_text: 'At terminal',
      events: [{ location: 'KAUNAS' }, { description: 'At sender' }] });
    // A courier's later rescan with the same clock keeps the tracker's order.
    const same = parseVenipak(wrap(history(row('2026-07-05 10:00', 'At terminal'), row('2026-07-05 10:00', 'Out for delivery'))), LOCKER);
    expect(same.events?.map(event => event.description)).toEqual(['Out for delivery', 'At terminal']);
  });

  it('binds the reply to the parcel and the number it searched', () => {
    expect(parseVenipak(wrap(locker), ` ${LOCKER.toLowerCase().replace('e', ' e')} `).status).toBe('delivered');
    for (const [body, number] of [
      [shipment, 'V00000E0000004'], [edit($ => $('#searchQuery').attr('value', `searched by: ${DOOR}`)), DOOR],
      [edit($ => $('#searchQuery').remove()), LOCKER], [edit($ => $('#searchQuery').clone().prependTo($.root())), LOCKER],
      [edit($ => $('#searchQuery').attr('value', `searched by: ${DOOR}`), shipment.replace(`parcel-${DOOR}`, `parcel-${LOCKER}`)), DOOR],
      [edit($ => $(`#parcel-${LOCKER}`).attr('id', 'parcel-')), LOCKER],
      [edit($ => $(`#parcel-${DOOR}`).attr('id', `parcel-${REST}`), shipment), REST],
    ] as const) {
      expect(() => parseVenipak(wrap(body), number), `${number}: ${body.slice(0, 80)}`).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const reply of [null, [], 'text', {}, { parcels: 1 }]) {
      expect(() => parseVenipak(reply, LOCKER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a shipment number only when the shipment holds one parcel', () => {
    const asShipment = (body: string) => edit($ => $('#searchQuery').attr('value', `searched by: ${SHIPMENT}`), body);
    const single = asShipment(edit($ => $(`#parcel-${REST}`).remove(), shipment));
    expect(parseVenipak(wrap(single), `00${SHIPMENT}`)).toMatchObject({ status: 'delivered', canonical_tracking_number: DOOR });
    expect(() => parseVenipak(wrap(asShipment(shipment)), SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    for (const body of [edit($ => $('#consignmentID').attr('value', '100000003'), single), edit($ => $('#consignmentID').remove(), single)]) {
      expect(() => parseVenipak(wrap(body), SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tells the exact not-found notice from the tracker\'s other answers', () => {
    expect(() => parseVenipak(wrap(absent), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const notice = (text: string) => edit($ => $('.error-message').text(text), absent);
    expect(() => parseVenipak(wrap(notice('Wrong shipment ID')), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    for (const body of [notice(`Shipment ${LOCKER} not found`), notice('Service temporarily unavailable'), notice(''),
      edit($ => $('.error-message').remove(), absent), edit($ => $('.error-message').clone().appendTo($.root()), absent)]) {
      expect(() => parseVenipak(wrap(body), UNKNOWN), body.slice(0, 120)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const withParcel = edit($ => $('<div class="error-message">Shipment V00000E0000001 not found</div>').insertAfter('#searchQuery'));
    expect(() => parseVenipak(wrap(withParcel), LOCKER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseVenipak(wrap(history()), LOCKER)).toThrowError(NoHistoryError);
  });

  it('rejects scans it cannot read and bounds the history', () => {
    for (const time of ['2026-13-01 10:00', '01.07.2026 10:15', '2026-07-01', '']) {
      expect(() => parseVenipak(wrap(history(row(time, 'At sender'))), LOCKER), time).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const noText = edit($ => $('.info-place').first().remove());
    expect(() => parseVenipak(wrap(noText), LOCKER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVenipak(wrap(history(row('2026-07-01 10:15', ', TALLINN'))), LOCKER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const scans = (count: number) => Array.from({ length: count }, (_, index) =>
      row(`2026-07-${String(1 + Math.floor(index / 60)).padStart(2, '0')} ${String(Math.floor(index % 60 / 6) + 8).padStart(2, '0')}:${String(index % 6 * 10).padStart(2, '0')}`, 'At terminal'));
    const long = parseVenipak(wrap(history(...scans(150))), LOCKER);
    expect(long.events).toHaveLength(100);
    expect(long.events?.[0]?.local_time).toBe('2026-07-03T12:50:00');
    expect(() => parseVenipak(wrap(history(...scans(150), ...scans(51))), LOCKER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown wording unstaged and reads only places that name a terminal or a Venipak point', () => {
    const unknown = parseVenipak(wrap(history(row('2026-07-01 10:15', 'At sender'), row('2026-07-02 10:15', 'Returned to sender, VILNIUS'))), LOCKER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Returned to sender' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events?.[0]).toEqual({ local_time: '2026-07-02T10:15:00', description: 'Returned to sender', location: 'VILNIUS' });
    for (const text of ['Out for delivery, Synthetic street 1, Tallinn', 'At terminal, Tallinn', 'Delivered, Courier Synthetic',
      'Delivered to pickup point, Venipak pickup point, Synthetic shop, Synthetic street 1, Tartu', 'Delivered to pickup point, Venipak locker',
      'At terminal, A VERY LONG NAME THAT RUNS PAST FORTY CAPITALS']) {
      const result = parseVenipak(wrap(history(row('2026-07-01 10:15', text))), LOCKER);
      expect(result.events?.[0]?.location, text).toBeUndefined();
      expect(result.pickup_point, text).toBeUndefined();
    }
    const point = parseVenipak(wrap(history(row('2026-07-01 10:15', 'Delivered to pickup point, Venipak pickup point, Synthetic shop'))), LOCKER);
    expect(point).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Synthetic shop', events: [{ location: 'Synthetic shop' }] });
    // A parcel taken on from the point, or brought to the door after it, has none.
    const onward = parseVenipak(wrap(history(row('2026-07-01 10:15', 'Delivered to pickup point, Venipak locker, Synthetic locker'),
      row('2026-07-02 10:15', 'Out for delivery'), row('2026-07-02 15:15', 'Delivered'))), LOCKER);
    expect(onward.status).toBe('delivered');
    expect(onward.pickup_point).toBeUndefined();
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      expect(venipakScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'venipak', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(venipakScanStage(' delivered ')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'venipak', description: 'THE PARCEL IS OUT FOR DELIVERY' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'venipak', providerCode: '9', description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Delivered to', 'Not delivered']) expect(venipakScanStage(wording), wording).toBeUndefined();
  });

  it('accepts parcel numbers and shipment numbers in the forms people type them', () => {
    expect(normalizeVenipakNumber(' v00000 e0000001 ')).toEqual({ query: LOCKER, kind: 'parcel' });
    expect(normalizeVenipakNumber('0100000002')).toEqual({ query: SHIPMENT, kind: 'shipment' });
    expect(normalizeVenipakNumber('1234567')).toEqual({ query: '1234567', kind: 'shipment' });
    expect(normalizeVenipakNumber('1234567890')).toEqual({ query: '1234567890', kind: 'shipment' });
    expect(normalizeVenipakParcelNumber(LOCKER)).toBe(LOCKER);
    expect(() => normalizeVenipakParcelNumber(SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    for (const number of ['V0000E0000001', 'V00000E000001', 'X00000E0000001', '123456', '12345678901', '00001234567', 'V00000E0000001X', '']) {
      expect(() => normalizeVenipakNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(venipakTrackingUrl(' v00000e0000001 ')).toBe(`${VENIPAK_ENDPOINT}${LOCKER}`);
    expect(VENIPAK_ENDPOINT).toBe('https://venipak.com/ee/en/wp-json/v1/shipment-tracker/');
  });

  it('keeps detection and the tracking link on Venipak', () => {
    expect(detectCarrierMatch(LOCKER)).toMatchObject({ carrier: 'venipak', confidence: 'high' });
    expect(parseTrackingInput(`https://venipak.com/lt/en/tracking/track/${LOCKER}/`))
      .toMatchObject({ trackingNumber: LOCKER, carrier: 'venipak', source: 'link' });
  });

  it('asks the tracking service once, with no session, and follows no redirect', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(`${VENIPAK_ENDPOINT}${LOCKER}`);
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.has('cookie')).toBe(false);
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ' v00000e0000001 ', postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.track({ number: 'V0000E0000001' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const bom = vi.fn(async () => reply(`\uFEFF${JSON.stringify(wrap(locker))}`)) as unknown as typeof fetch;
    expect(await new VenipakTracker({ fetcher: bom }).fetch(LOCKER)).toMatchObject({ status: 'delivered' });
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    for (const [status, kind] of [[301, 'indeterminate'], [302, 'indeterminate'], [404, 'indeterminate'], [410, 'indeterminate'],
      [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const headers: Record<string, string> = status < 400 ? { Location: 'https://venipak.com/' } : {};
      const fetcher = vi.fn(async () => reply(wrap(absent), status, headers)) as unknown as typeof fetch;
      await expect(new VenipakTracker({ fetcher }).fetch(LOCKER), String(status)).rejects.toMatchObject({ kind });
    }
    const challenge = vi.fn(async () => reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      200, { 'Content-Type': 'text/html' })) as unknown as typeof fetch;
    await expect(new VenipakTracker({ fetcher: challenge }).fetch(LOCKER)).rejects.toMatchObject({ kind: 'challenge' });
    const page = vi.fn(async () => reply('<html><head><title>Venipak</title></head><body>Parcel tracking</body></html>', 200,
      { 'Content-Type': 'text/html' })) as unknown as typeof fetch;
    await expect(new VenipakTracker({ fetcher: page }).fetch(LOCKER)).rejects.toMatchObject({ kind: 'schema' });
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new VenipakTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(LOCKER)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const absentOnce = vi.fn(async () => reply(wrap(absent)));
    await expect(new VenipakTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new VenipakTracker({ fetcher: large }).fetch(LOCKER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known parcel number and treats only the absent answer as unknown', async () => {
    const known = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!(SHIPMENT)).toEqual({ known: false });
    expect(await instance.recognize!('V0000E0000001')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    // A local clock dates the last activity without an instant.
    expect(await instance.recognize!(LOCKER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-04T18:02:00' });
    const unknown = vi.fn(async () => reply(wrap(absent)));
    expect(await adapter(environment(unknown as unknown as typeof fetch)).recognize!(UNKNOWN)).toEqual({ known: false });
    const outage = vi.fn(async () => reply('<html>Maintenance</html>', 200, { 'Content-Type': 'text/html' }));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(LOCKER)).rejects.toMatchObject({ kind: 'schema' });
    const limited = vi.fn(async () => reply('error code: 1015', 429, { 'Content-Type': 'text/plain' }));
    await expect(adapter(environment(limited as unknown as typeof fetch)).recognize!(LOCKER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new VenipakTracker({ fetcher: immediate }).fetch(LOCKER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new VenipakTracker({ fetcher: immediate }).fetch(LOCKER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new VenipakTracker({ fetcher: slow }).fetch(LOCKER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
