import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JS_EXPRESS_PAGE, JS_EXPRESS_TRACKER, JsExpressTracker } from './adapter.js';
import { jsExpressReply, jsExpressScan, normalizeJsExpressNumber, parseJsExpress } from './parser.js';
import { jsExpressMappedStage, jsExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JSEZZ0000000001YQ';
const IN_TRANSIT = 'JSEZZ0000000002YQ';
const UNKNOWN = 'JSEZZ0000000003YQ';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const parsed = (name: string) => JSON.parse(page(name)) as unknown;
// The lookup answers JSON as HTML.
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
interface Row { date?: unknown; address?: unknown; status?: unknown; timeZone?: string }
// One history row, as the lookup writes it.
const row = (date: string, address: string, status: string): Row => ({ date, status, address, timeZone: '+08:00' });
// A reply for the delivered fixture's number, with these rows and waybill fields.
const waybill = (tracking: unknown, fields: Record<string, unknown> = {}) => ({ code: 0, message: 'Success',
  data: [{ jsWaybillNo: DELIVERED, orderNo: 'SN000000000009', trackNo: '', country: 'Canada', pod: [], tracking, ...fields }] });
const withList = (rows: Row[]) => waybill(rows);
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>';

describe('JS Express tracking adapter', () => {
  it('posts the whole number to the lookup once, as the English tracking page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JsExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jsezz 0000000001 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(JS_EXPRESS_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `card_num=${DELIVERED}`,
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded',
        Referer: JS_EXPRESS_PAGE, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'js-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel delivered abroad in the reply\'s order, with the courier\'s place as the location', () => {
    const result = parseJsExpress(parsed('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T20:41:05Z', delivered_at: '2026-03-12T20:41:05Z', expected_delivery: null,
      destination_country: 'CA', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000001' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      // Straightship's rows, on the UTC clock of its own page.
      ['2026-03-12T20:41:05Z', 'Sample Town, ON', 'Delivered', 'delivered'],
      // Straightship's round: the delivery follows the same day.
      ['2026-03-12T11:20:44Z', 'Sample Town, ON', 'Package will be delivered before 9:00pm', 'out_for_delivery'],
      ['2026-03-12T08:02:13Z', 'Sample City, ON', 'Package is received at a Straightship station', 'in_transit'],
      ['2026-03-11T17:45:30Z', 'Sample Hub, ON', 'Package is received at a Straightship station', 'in_transit'],
      ['2026-03-11T17:45:30Z', 'Sample Hub, ON', 'Package Received with Origin Scan warehouse', 'in_transit'],
      // Airports' codes keep their wall clocks.
      ['2026-03-09T18:10:09', 'YYZ', 'Delivery to local courier', 'in_transit'],
      ['2026-03-09T12:31:52', 'YYZ', 'Released From Import Customs', 'in_transit'],
      ['2026-03-09T05:02:40', 'YYZ', 'The goods have been picked up abroad', 'in_transit'],
      ['2026-03-08T03:40:11', 'YYZ', 'NOA-Notification of arrival from GHA', 'in_transit'],
      ['2026-03-07T19:55:26', 'YYZ', 'Item Flight landing', 'in_transit'],
      ['2026-03-07T12:14:37', 'YVR', 'Connecting flights flight takeoff', 'in_transit'],
      // Clocks of different countries: the page's order stands. A flight keeps its wall clock, even filed in China.
      ['2026-03-07T10:20:15', 'China', 'Item Flight departure', 'in_transit'],
      ['2026-03-07T05:31:48', 'YVR', 'Initial landing', 'in_transit'],
      // Rows at places in China, on Beijing time.
      ['2026-03-05T21:10:00+08:00', 'China', 'Released From Export Customs', 'in_transit'],
      ['2026-03-05T19:10:00+08:00', 'China', 'Arrive at international airport to abroad', 'in_transit'],
      ['2026-03-05T09:12:30+08:00', 'South China Transit Center', 'Item departed from origin.', 'in_transit'],
      // The row the page lists twice is kept once.
      ['2026-03-04T15:01:22+08:00', 'Dongguan General Warehouse-Operation Center', 'Item outbound in sorting center.', 'in_transit'],
      ['2026-03-04T03:22:05+08:00', 'Dongguan General Warehouse-Operation Center', 'Item inbound in sorting center.', 'in_transit'],
      ['2026-03-04T03:10:47+08:00', 'Dongguan General Warehouse-Operation Center', 'Item has been collected', 'accepted'],
      // Straightship's record of the data moves nothing; an empty 【】 names no place, and the row is on Straightship's UTC.
      ['2026-03-03T19:40:02Z', undefined, 'Package information is created in the system', undefined],
      ['2026-03-03T08:15:33+08:00', 'Dongguan General Warehouse-Operation Center', 'Electronic notification of order creation received.', 'registered'],
    ]);
    expect(result.events!.every(event => Boolean(event.time) !== Boolean(event.local_time))).toBe(true);
    expect(result.events!.filter(event => event.stage).every(event => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a parcel announced at the destination airport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    // The airport's row keeps its wall clock, so the last update has no instant.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'NOA-Notification of arrival from GHA', last_update: null, last_update_local: '2026-04-16T06:12:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2026-04-16T06:12:00', location: 'AMS', description: 'NOA-Notification of arrival from GHA', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-15T22:30:00', location: 'AMS', description: 'Item Flight landing', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-15T22:30:00', location: 'AMSTERDAM', description: 'ARRIVED AT DESTINATION AIRPORT', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.find(event => event.description === 'SHIPPING INFORMATION RECEIVED')).toEqual(
      { local_time: '2026-04-15T10:44:18', description: 'SHIPPING INFORMATION RECEIVED' });
    expect(result.events!.at(-1)).toEqual({ time: '2026-04-11T23:10:58+08:00', location: 'China, Transit Center',
      description: 'Electronic notification of order creation received.', stage: 'registered', stage_source: 'carrier_map' });
    // Rows at places in China are on Beijing time; the flights and the rows at Hong Kong, Amsterdam or no place keep their wall clocks.
    expect(result.events!.filter(event => event.time).map(event => [event.time, event.location])).toEqual([
      ['2026-04-14T21:58:00+08:00', 'China'],
      ['2026-04-14T19:58:00+08:00', 'China'],
      ['2026-04-14T09:01:36+08:00', 'South China Transit Center'],
      ['2026-04-14T01:06:50+08:00', 'China, Transit Center'],
      ['2026-04-13T22:35:12+08:00', 'China, Transit Center'],
      ['2026-04-13T17:44:09+08:00', 'China, Transit Center'],
      ['2026-04-11T23:10:58+08:00', 'China, Transit Center'],
    ]);
    expect(fetcher.mock.calls[0]![1]!.body).toBe(`card_num=${IN_TRANSIT}`);
  });

  it('dates rows at places in China on Beijing time, and keeps flights, airports\' codes and other places on their wall clocks', () => {
    const clocks = (...rows: Row[]) => parseJsExpress(withList(rows), DELIVERED).events!.map(event => event.time ?? event.local_time);
    expect(clocks(
      // The country, a region, a province and cities, each opening the label.
      row('2026-05-01 09:00:00', 'China', 'Released From Export Customs'),
      row('2026-05-01 08:00:00', 'China,  Transit Center', 'Item outbound in sorting center.'),
      row('2026-05-01 07:00:00', 'East China Transit Center', 'Item departed from origin.'),
      row('2026-05-01 06:00:00', 'Zhejiang', 'Domestic allocation has begun'),
      row('2026-05-01 05:00:00', 'Yiwu Sorting Center', 'Item inbound in sorting center.'),
      row('2026-05-01 04:00:00', "Xi'an Operation Center", 'Item has been collected'),
      // A warehouse written in Chinese.
      row('2026-05-01 03:00:00', '示例总仓库-操作中心', 'Item has been collected'),
    )).toEqual(['2026-05-01T09:00:00+08:00', '2026-05-01T08:00:00+08:00', '2026-05-01T07:00:00+08:00', '2026-05-01T06:00:00+08:00',
      '2026-05-01T05:00:00+08:00', '2026-05-01T04:00:00+08:00', '2026-05-01T03:00:00+08:00']);
    expect(clocks(
      // A flight filed in China, an airport's code in China, Hong Kong and no place.
      row('2026-05-02 09:00:00', 'China', 'Item Flight departure'),
      row('2026-05-02 08:00:00', 'Sample Town', 'Connecting flights flight takeoff'),
      row('2026-05-02 07:00:00', 'TNA', 'Arrive at international airport to abroad'),
      row('2026-05-02 06:00:00', 'HONG KONG', 'UPLIFTED FROM TRANSSHIPMENT HUB'),
      row('2026-05-02 05:00:00', '', 'Arrive at transit center'),
      // Towns abroad that start like China's names, a town named China in a US state, and a center no name places.
      row('2026-05-02 04:00:00', 'China Grove', 'Out for delivery'),
      row('2026-05-02 03:30:00', 'Chinatown', 'Out for delivery'),
      row('2026-05-02 03:00:00', 'China', 'Delivered (China, ME)'),
      row('2026-05-02 02:00:00', 'Sample General Warehouse-Operation Center', 'Item has been collected'),
      // Hong Kong and a Japanese place, written in their scripts.
      row('2026-05-02 01:30:00', '香港转运中心', 'Arrive at transit center'),
      row('2026-05-02 01:00:00', '東京センター', 'Arrive at transit center'),
    )).toEqual(['2026-05-02T09:00:00', '2026-05-02T08:00:00', '2026-05-02T07:00:00', '2026-05-02T06:00:00', '2026-05-02T05:00:00',
      '2026-05-02T04:00:00', '2026-05-02T03:30:00', '2026-05-02T03:00:00', '2026-05-02T02:00:00', '2026-05-02T01:30:00', '2026-05-02T01:00:00']);
  });

  it('dates Straightship\'s rows on UTC only in a history that names it, and keeps other couriers\' wall clocks', () => {
    const clocks = (...rows: Row[]) => parseJsExpress(withList(rows), DELIVERED).events!.map(event => [event.time ?? event.local_time, event.location]);
    const attempt = 'An attempt was made to deliver your package-consignee closed (please e-mail SS@straightship.com to make arrangement)';
    expect(clocks(
      row('2026-05-03 21:10:00', 'Sample Town', 'Delivered (Sample Town, BC)'),
      // An attempt without a place names Straightship.
      row('2026-05-02 20:00:00', '', attempt),
      row('2026-05-02 08:00:00', 'Sample City', 'Package is received at a Straightship station (Sample City, BC)'),
      // A town of a US state and an airport's code keep their wall clocks.
      row('2026-05-01 12:00:00', 'Sample Port', 'Delivered (Sample Port, WA)'),
      row('2026-05-01 10:00:00', 'YVR', 'Delivery to local courier'),
      // Straightship's record of the data, as its own page dates it.
      row('2026-04-28 19:00:00', '', 'Package information is created in the system'),
    )).toEqual([
      ['2026-05-03T21:10:00Z', 'Sample Town, BC'],
      ['2026-05-02T20:00:00Z', undefined],
      ['2026-05-02T08:00:00Z', 'Sample City, BC'],
      ['2026-05-01T12:00:00', 'Sample Port, WA'],
      ['2026-05-01T10:00:00', 'YVR'],
      ['2026-04-28T19:00:00Z', undefined],
    ]);
    // Without a row naming Straightship, a courier's town and province and a record of the data are no clock.
    expect(clocks(row('2026-05-03 21:10:00', 'Sample Town', 'Delivered (Sample Town, BC)'),
      row('2026-05-02 08:00:00', 'Sample City', 'Package arrived at transit station (Sample City, BC)'),
      row('2026-04-28 19:00:00', '', 'Package information is created in the system')))
      .toEqual([['2026-05-03T21:10:00', 'Sample Town, BC'], ['2026-05-02T08:00:00', 'Sample City, BC'], ['2026-04-28T19:00:00', undefined]]);
  });

  it('follows the newest row\'s instant with the last update, and a dated delivery\'s with the delivery time', () => {
    const read = (...rows: Row[]) => {
      const { current_stage, last_update, last_update_local, delivered_at } = parseJsExpress(withList(rows), DELIVERED);
      return { current_stage, last_update, last_update_local, delivered_at };
    };
    const china = [row('2026-05-01 18:00:00', 'Sample Hub', 'Package information is created in the system'),
      row('2026-05-01 09:00:00', 'Shenzhen Sorting Center', 'Item has been collected')];
    // In China: the collection's instant, though an older-looking record of the data has none.
    expect(read(china[1]!)).toEqual({ current_stage: 'accepted', last_update: '2026-05-01T09:00:00+08:00', last_update_local: undefined, delivered_at: undefined });
    // A newer row without an instant leaves the last update a wall clock.
    expect(read(...china)).toEqual({ current_stage: 'accepted', last_update: null, last_update_local: '2026-05-01T18:00:00', delivered_at: undefined });
    expect(read(row('2026-05-03 10:00:00', 'China', 'Item Flight departure'), china[1]!))
      .toMatchObject({ last_update: null, last_update_local: '2026-05-03T10:00:00' });
    // Straightship's delivery dates the parcel's delivery.
    const straightship = [row('2026-05-09 08:00:00', 'Sample City', 'Package is received at a Straightship station (Sample City, ON)'),
      row('2026-05-08 19:00:00', 'YYZ', 'Delivery to local courier'), china[1]!];
    expect(read(...straightship)).toEqual({ current_stage: 'in_transit', last_update: '2026-05-09T08:00:00Z', last_update_local: undefined, delivered_at: undefined });
    expect(read(row('2026-05-10 17:30:00', 'Sample Town', 'Delivered (Sample Town, ON)'), ...straightship))
      .toEqual({ current_stage: 'delivered', last_update: '2026-05-10T17:30:00Z', last_update_local: undefined, delivered_at: '2026-05-10T17:30:00Z' });
    // Another courier's delivery keeps its wall clock, and gives no delivery time.
    expect(read(row('2026-05-10 15:40:00', 'Sample01', '【Sample01】Delivered, Receiver Type:【Self】.'), row('2026-05-08 19:00:00', 'LGG', 'Delivery to local courier'), china[1]!))
      .toEqual({ current_stage: 'delivered', last_update: null, last_update_local: '2026-05-10T15:40:00', delivered_at: undefined });
  });

  it('moves a courier\'s place into the location and drops who took a delivery and phone numbers', () => {
    expect(jsExpressScan('Delivered (Sample Town, ON)', 'Sample Town')).toEqual({ description: 'Delivered', location: 'Sample Town, ON' });
    // A place the label does not name stays in the wording.
    expect(jsExpressScan('Held at depot (weekend)', 'Sample Town')).toEqual({ description: 'Held at depot (weekend)', location: 'Sample Town' });
    expect(jsExpressScan('Delivered (Sample Town, ON)', '')).toEqual({ description: 'Delivered (Sample Town, ON)', location: '' });
    expect(jsExpressScan('Delivered, signed by A SAMPLE PERSON', 'Sample Town').description).toBe('Delivered');
    expect(jsExpressScan('Delivered - received by A SAMPLE PERSON (Sample Town, ON)', 'Sample Town').description).toBe('Delivered');
    expect(jsExpressScan('Delivered Signature: SAMPLE', 'Sample Town').description).toBe('Delivered');
    expect(jsExpressScan('Delivery attempted, call +1 555 000 0000', 'Sample Town').description).toBe('Delivery attempted, call');
    // JS Express's own notice loses the label of the local office's number with it.
    expect(jsExpressScan('收件人地址不详或有误，派送失败，麻烦让收件人联系下当地，当地电话：555 0000 0000', 'US').description)
      .toBe('收件人地址不详或有误，派送失败，麻烦让收件人联系下当地');
    // Its English, the number gone and a slash left after the label.
    const notice = 'The delivery address is incorrect. Please ask the recipient to contact their local area? Local phone number:/';
    expect(jsExpressScan(notice, 'US').description).toBe('The delivery address is incorrect. Please ask the recipient to contact their local area?');
    expect(jsExpressScan(notice.replace(':/', ':/555 0000 0000'), 'US').description)
      .toBe('The delivery address is incorrect. Please ask the recipient to contact their local area?');
    expect(jsExpressScan('Delivery failed. Phone: +1 555 000 0000', 'Sample Town').description).toBe('Delivery failed.');
    // A label without a letter names no place, and the row reads as it would without one.
    expect(jsExpressScan(notice, '1')).toEqual({ description: 'The delivery address is incorrect. Please ask the recipient to contact their local area?', location: '' });
    const history = (label: string) => parseJsExpress(withList([
      row('2026-05-03 10:20:00', label, notice),
      row('2026-05-02 09:00:00', 'Sample Town, NY', 'Departed USPS Facility'),
    ]), DELIVERED).events?.[0];
    expect(history('1')).toEqual(history(''));
    expect(history('1')).not.toHaveProperty('location');
    // The row stored with it is taken over by the row without it, and only such a row.
    const policy = sameInstantIdentityPolicy('js-express', { supportsScanMatching: true });
    const scan = { stage: 'failed_attempt', description: history('')!.description!, location: '', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, location: '1' })).toBe(true);
    expect(policy?.matches?.(scan, { ...scan, location: 'Sample Town, NY' })).toBe(false);
    // Only a delivery's wording loses a "by" clause.
    expect(jsExpressScan('Picked up by the airline', 'HKG').description).toBe('Picked up by the airline');
  });

  it('stages new wording through the shared rules and keeps the rest without a stage', () => {
    const one = (wording: string) => parseJsExpress(withList([row('2026-05-01 09:00:00', 'Sample Town', wording)]), DELIVERED);
    expect(one('Out for delivery')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const unknown = one('Sample counter scan');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan', last_update_local: '2026-05-01T09:00:00' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events).toEqual([{ local_time: '2026-05-01T09:00:00', location: 'Sample Town', description: 'Sample counter scan' }]);
    // A partner's record of the data is the newest row: the older scan sets the stage.
    const recorded = parseJsExpress(withList([row('2026-05-01 10:00:00', '', 'SHIPMENT CREATED'),
      row('2026-05-01 09:00:00', 'Sample Center', 'Item has been collected')]), DELIVERED);
    expect(recorded).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'SHIPMENT CREATED' });
  });

  it("stages a customs warehouse's inbound, and a courier's announcement of the parcel moves nothing", () => {
    const announced = parseJsExpress(withList([
      row('2026-05-02 10:00:00', 'Sample Town', 'Your package is being prepared by the sender and will be handed over to us soon'),
      row('2026-05-02 09:00:00', 'AMS', 'Inbound to customs temporary warehouse')]), DELIVERED);
    expect(announced).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map' });
    expect(announced.events?.map((event) => [event.stage, event.stage_source])).toEqual([[undefined, undefined], ['customs', 'carrier_map']]);
  });

  it('shows its own status in Chinese in English, staged as the Chinese, and the map stages the English too', () => {
    const waiting = parseJsExpress(withList([row('2026-05-03 09:00:00', 'FR', '到达待取')]), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Arrived, awaiting collection' });
    expect(waiting.events).toMatchObject([{ description: 'Arrived, awaiting collection', stage: 'ready_for_pickup', stage_source: 'carrier_map' }]);
    expect(statusMap.stage(null, normalizeStatusWording('Arrived, awaiting collection'))).toBe('ready_for_pickup');
  });

  it("reads USPS's forwarding alert, which names its time, day and town, as the parcel going on", () => {
    const alert = 'Alert, Forwarded -> Your item was forwarded to a different address at 7:00 am on January 2, 2030 in SAMPLE TOWN, MA. '
      + 'This was because of forwarding instructions or because the address or ZIP Code on the label was incorrect.';
    expect(jsExpressMappedStage(alert)).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'js-express', description: alert })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(jsExpressMappedStage('Alert, Forwarded')).toBeUndefined();
  });

  it("reads iMile's scans as its destination courier by iMile's sentences, whichever centres they name", () => {
    for (const [wording, stage] of [
      ['【iMile Sample DC Center】Received.', 'in_transit'],
      ['【iMile Sample DC Center】Parcel shipped to【Sample01】.', 'in_transit'],
      ['【Other Hub】Parcel shipped to【Other02】.', 'in_transit'],
      ['【Sample DS】Shipment out for delivery.', 'out_for_delivery'],
    ] as const) {
      expect(jsExpressMappedStage(wording), wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'js-express', description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // Only a wording that opens with a centre's name in 【】 is iMile's; a scan that moves nothing has no stage.
    expect(jsExpressMappedStage('Parcel shipped to【Sample01】.')).toBeUndefined();
    expect(jsExpressMappedStage('【Sample Hub】Inventory count scan.')).toBeUndefined();
  });

  it("keeps a Colissimo leg's announced return open until the parcel is back with its sender", () => {
    const announced = parseJsExpress(withList([
      row('2026-05-03 14:00:00', 'Sample Center', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur.")]), DELIVERED);
    expect(announced).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    const back = parseJsExpress(withList([
      row('2026-05-05 10:00:00', 'Sample Center', "Votre colis est livré à son expéditeur à la suite d'un retour."),
      row('2026-05-03 14:00:00', 'Sample Center', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur.")]), DELIVERED);
    expect(back).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map' });
  });

  it('reads the lookup\'s "no data" answer as not found, a waybill without scans as no history, and an empty reply as inconclusive', async () => {
    expect(() => parseJsExpress(parsed('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJsExpress(withList([]), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The Chinese page's lookup answers a wrong captcha so; a refusal alone is a block too.
    expect(() => parseJsExpress({ code: -1, message: '验证码错误，请重新输入' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJsExpress({ code: 1, message: '非法请求' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJsExpress({ code: 1, data: null, message: 'Sample service notice' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CLOUDFLARE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"code":1,"message":"非法请求"}')).rejects.toMatchObject({ kind: 'challenge' });
    // Without the page as its referrer, the lookup prints its refusal and then answers.
    await expect(lookup(`{"code":1,"message":"非法请求"}${page('delivered')}`, DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(() => jsExpressReply('{"code":1,"message":"非法请求"}{"code":0')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested number and rejects a changed reply', () => {
    expect(() => parseJsExpress(parsed('delivered'), 'JSEZZ0000000009YQ'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'JS Express answered for another waybill' }));
    expect(parseJsExpress(JSON.parse(page('delivered').replace(`"${DELIVERED}"`, `"${DELIVERED.toLowerCase()}"`)), DELIVERED).events).toHaveLength(21);
    const delivered = page('delivered');
    const scans = (parsed('delivered') as { data: { tracking: Row[] }[] }).data[0]!.tracking;
    const first = (change: Partial<Row>) => waybill([{ ...scans[0]!, ...change }, ...scans.slice(1)]);
    for (const changed of [
      [],
      {},
      { code: '0', data: [] },
      { code: 0, data: {} },
      { code: 0, data: [{ waybill: DELIVERED, tracking: scans }] },
      waybill(scans, { jsWaybillNo: 'JSEZZ0000000009YQ' }),
      { code: 0, data: [...waybill(scans).data, ...waybill(scans).data] },
      waybill({}),
      waybill(scans, { country: 1 }),
      first({ date: '12/03/2026 20:41' }),
      first({ date: '2026-02-30 20:41:05' }),
      first({ date: '2026-03-12 24:00:00' }),
      first({ date: undefined }),
      first({ status: ' ' }),
      first({ status: 1 }),
      first({ address: ['Sample Town'] }),
      JSON.parse(delivered.replace('"tracking": [', '"tracking": [1, ')),
    ]) {
      expect(() => parseJsExpress(changed, DELIVERED), JSON.stringify(changed).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const long = Array.from({ length: 501 }, () => row('2026-05-01 09:00:00', 'Sample Town', 'Item Flight landing'));
    expect(() => parseJsExpress(withList(long), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('names the destination courier\'s number, and the courier when the catalog settles the number for one at home where the parcel goes', () => {
    const scans = [row('2026-05-03 10:00:00', 'YYZ', 'Delivery to local courier')];
    const read = (fields: Record<string, unknown>) => {
      const { destination_country, destination_country_name, delivery_carrier, delivery_tracking_number } = parseJsExpress(waybill(scans, fields), DELIVERED);
      return { destination_country, destination_country_name, delivery_carrier, delivery_tracking_number };
    };
    expect(read({ trackNo: 'STRCA0000000000001', country: 'Canada' }))
      .toEqual({ destination_country: 'CA', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000001' });
    expect(read({ trackNo: 'H1000000000000000001', country: 'Germany' }))
      .toEqual({ destination_country: 'DE', delivery_carrier: 'hermes-de', delivery_tracking_number: 'H1000000000000000001' });
    expect(read({ trackNo: '6A12345678905', country: 'France' }))
      .toEqual({ destination_country: 'FR', delivery_carrier: 'la-poste', delivery_tracking_number: '6A12345678905' });
    // A USPS routing barcode gives its package identifier.
    expect(read({ trackNo: '420000009400100000000000000006', country: 'United States' }))
      .toEqual({ destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: '9400100000000000000006' });
    // A courier that does not work where the parcel goes, a number the catalog does not settle, or no country names no courier.
    expect(read({ trackNo: 'H1000000000000000001', country: 'France' }))
      .toEqual({ destination_country: 'FR', delivery_tracking_number: 'H1000000000000000001' });
    expect(read({ trackNo: '12345678901234', country: 'Germany' })).toEqual({ destination_country: 'DE', delivery_tracking_number: '12345678901234' });
    expect(read({ trackNo: 'STRCA0000000000001', country: 'Sample Land' }))
      .toEqual({ destination_country_name: 'Sample Land', delivery_tracking_number: 'STRCA0000000000001' });
    // No number yet, the waybill's own, or one that is no tracking number.
    for (const trackNo of ['', null, DELIVERED, 'SAMPLE NUMBER?']) expect(read({ trackNo, country: 'Canada' }), String(trackNo)).toEqual({ destination_country: 'CA' });
    // The tracker hands the parcel to the courier's adapter.
    expect(deliveryHandoff('js-express', DELIVERED, parseJsExpress(parsed('delivered'), DELIVERED)))
      .toEqual({ carrier: 'straightship', number: 'STRCA0000000000001', basis: 'partner' });
    expect(deliveryHandoff('js-express', IN_TRANSIT, parseJsExpress(parsed('in-transit'), IN_TRANSIT)))
      .toEqual({ carrier: 'hermes-de', number: 'H1000000000000000001', basis: 'partner' });
  });

  it('keeps the newest hundred rows of a long history and says it cut the rest', () => {
    const rows = Array.from({ length: 120 }, (_, index) =>
      row(`2026-05-01 ${String(Math.floor((119 - index) / 60)).padStart(2, '0')}:${String((119 - index) % 60).padStart(2, '0')}:00`, 'Sample Hub', 'Item Flight landing'));
    const result = parseJsExpress(withList(rows), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-05-01T01:59:00' });
  });

  it('takes JS Express waybills, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JSEZZ000000001YQ', 'JSEZZ00000000001YQ', 'JSEZZ0000000001YR', 'FEISH0000000001YQ', 'WNBZZ0000000001YQ',
      'JSE0000000000001YQ', '12345678901', `JSEZZ${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJsExpressNumber(' jsezz-0000 0000 01 yq ')).toBe(DELIVERED);
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('in-transit')))
      .mockResolvedValueOnce(reply(page('not-found')));
    // The newest dated row dates the parcel's last activity: the delivery, or the export release before the flight's wall clocks.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T20:41:05.000Z' });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-14T13:58:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a JS Express waybill, which detection settles, to the adapter, which names the destination courier', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'js-express', confidence: 'high' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'js-express', source: 'js-express',
      result: { current_stage: 'delivered', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000001' } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(JS_EXPRESS_TRACKER);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === JS_EXPRESS_TRACKER)).toHaveLength(1);
  });
});

describe('JS Express status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves records of data and forecasts out', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      if (!('stage' in entry)) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'js-express', description: entry.wording }), entry.wording).toMatchObject({ kind: 'intentional_gap' });
        expect(jsExpressStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(jsExpressMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'js-express', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(jsExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.gaps.every(gap => gap.wording && gap.note)).toBe(true);
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(jsExpressMappedStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(jsExpressStage('')).toBeNull();
  });
});
