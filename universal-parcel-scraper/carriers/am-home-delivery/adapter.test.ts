import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AM_HOME_DELIVERY_LOOKUP, AmHomeDeliveryTracker, amHomeDeliveryLookupUrl, amHomeDeliveryPageUrl } from './adapter.js';
import { normalizeAmHomeDeliveryNumber, parseAmHomeDelivery } from './parser.js';
import { amHomeDeliveryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '30000017';
const DELIVERED_BOL = '7000001';
const IN_TRANSIT = 'AM000000123';
const PENDING = '30000025';
const UNKNOWN = '30000033';
// The NetSuite page the lookup redirects to; the access parameter is invented.
const PAGE = 'https://4301600.extforms.netsuite.com/app/site/hosting/scriptlet.nl';
const pageUrl = (number: string) => `${PAGE}?script=1&deploy=1&compid=4301600&ns-at=SYNTHETIC-ACCESS-0000&number=${number}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
/** The lookup's redirect for the number in its address, then the page. */
const serving = (page: () => Response, location: (number: string) => string = pageUrl) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => {
    const address = new URL(String(url));
    if (address.href.startsWith(AM_HOME_DELIVERY_LOOKUP)) return redirect(location(address.searchParams.get('cnumber')!));
    return page();
  });
const shipment = (name: string) => serving(() => html(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const AKAMAI = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference&#32;&#35;18&#46;0 https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;</BODY></HTML>';
const events = (result: ReturnType<typeof parseAmHomeDelivery>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);
const edit = (name: string, change: (page: string) => string) => {
  const page = fixture(name);
  const changed = change(page);
  expect(changed).not.toBe(page);
  return changed;
};

describe('AM Home Delivery HTTP adapter', () => {
  it('opens the tracking form’s lookup for the whole number and follows its redirect, through the supplied transport', async () => {
    const fetcher = shipment('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AmHomeDeliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' am 0000 00123 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookup, lookupInit], [page, pageInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(lookup)).toBe(`${AM_HOME_DELIVERY_LOOKUP}?cnumber=${IN_TRANSIT}`);
    expect(String(page)).toBe(pageUrl(IN_TRANSIT));
    for (const init of [lookupInit, pageInit]) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init.body).toBeUndefined();
    }
    expect(amHomeDeliveryLookupUrl('30000017')).toBe(`${AM_HOME_DELIVERY_LOOKUP}?cnumber=${DELIVERED}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'am-home-delivery', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first as wall clocks, at towns, without the products, the address or the bill of lading', () => {
    const result = parseAmHomeDelivery(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'COMPLETED', last_update: null, last_update_local: '2026-03-12T16:37:00', expected_delivery: null,
    });
    for (const field of ['summary_only', 'expected_delivery_from', 'canonical_tracking_number', 'receiver_name', 'sender_name', 'delivered_at']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-12T16:37:00', 'COMPLETED', 'delivered', 'Sampleford, Colorado'],
      ['2026-03-10T12:15:00', 'Scheduled', 'in_transit', 'Example City, Colorado'],
      // The repeated row is kept once.
      ['2026-03-09T14:20:00', 'Received in Delivery Terminal', 'in_transit', 'Example City, Colorado'],
      // "In Transit" in the place column names no place.
      ['2026-03-05T06:21:00', 'In-Transit to Delivery Terminal', 'in_transit', null],
      ['2026-03-03T00:05:00', 'Received in Consolidation Center', 'accepted', 'Sample Township, New Jersey'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/80999|80998|08999|7000001|SOFA|Sofa|LIFTGATE|example\.com|555|2026-03-02/);
  });

  it('reads an in-transit history, its range of days as the estimate, and a row without a place', () => {
    const result = parseAmHomeDelivery(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Received in Delivery Terminal', last_update: null, last_update_local: '2026-03-14T13:07:00',
      expected_delivery_from: '2026-03-17', expected_delivery: '2026-03-24',
    });
    expect(events(result)).toEqual([
      ['2026-03-14T13:07:00', 'Received in Delivery Terminal', 'in_transit', 'Sample Junction, New Jersey'],
      ['2026-03-14T12:04:00', 'Received in Consolidation Center', 'accepted', 'Sample Junction, New Jersey'],
      ['2026-03-13T16:32:00', 'Pickup Notification Received', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample Harbor|02999|08998|70022|Fridge/);
    // An appointment's window is read as its day; a list oldest first is turned round.
    const appointment = parseAmHomeDelivery(edit('in-transit', (page) => page
      .replace('17-Mar-2026 to 24-Mar-2026', '18-Mar-2026 at 11:30:00 - 18-Mar-2026 at 15:30:00')), IN_TRANSIT);
    expect(appointment).toMatchObject({ expected_delivery: '2026-03-18' });
    expect(appointment).not.toHaveProperty('expected_delivery_from');
    const oldestFirst = edit('in-transit', (page) => {
      const rows = page.match(/<tr>\s*<td>1[34]-Mar-2026<\/td>[\s\S]*?<\/tr>/g)!;
      return page.replace(rows.join('\n            '), [...rows].reverse().join('\n            '));
    });
    expect(events(parseAmHomeDelivery(oldestFirst, IN_TRANSIT))).toEqual(events(result));
    // An estimate the page writes another way, or none, is left out.
    for (const estimate of ['TBD', '24-Mar-2026 to 17-Mar-2026', '17-Mar-2026 to 30-Feb-2026']) {
      expect(parseAmHomeDelivery(edit('in-transit', (page) => page.replace('17-Mar-2026 to 24-Mar-2026', estimate)), IN_TRANSIT), estimate)
        .toMatchObject({ expected_delivery: null });
    }
  });

  it('takes the further of the newest staged row and the summary, and lets a delivery or a problem settle it', () => {
    const rail = (label: string) => (page: string) => page.replace('<li class="actual">', '<li class="active">')
      .replace(`<li>\n                <div class="step"></div>\n                <div class="stamp">\n                    <span class="event">${label} </span>`,
        `<li class="actual">\n                <div class="step"></div>\n                <div class="stamp">\n                    <span class="event">${label} </span>`);
    // The rail's step ahead of every row is the current state, without a clock.
    const out = parseAmHomeDelivery(edit('in-transit', rail('Out For Delivery')), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out For Delivery', expected_delivery: '2026-03-24' });
    expect(out).not.toHaveProperty('last_update_local');
    // The summary settles a delivery the history does not record yet.
    const completed = parseAmHomeDelivery(edit('in-transit', (page) => page.replace('<span class="info-data"> Scheduled <!--Token--> </span>',
      '<span class="info-data"> COMPLETED <!--Token--> </span>')), IN_TRANSIT);
    expect(completed).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'COMPLETED', expected_delivery: null });
    expect(completed).not.toHaveProperty('expected_delivery_from');
    expect(completed).not.toHaveProperty('last_update_local');
    // A problem the last mile status names is the current state.
    const attempted = parseAmHomeDelivery(edit('in-transit', (page) => page.replace('<span class="info-data"> Scheduled <!--Token--> </span>',
      '<span class="info-data"> Delivery Attempted <!--Token--> </span>')), IN_TRANSIT);
    expect(attempted).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery Attempted' });
    // A problem in the newest staged row outranks a summary ahead of it.
    const refused = parseAmHomeDelivery(edit('in-transit', (page) => rail('Out For Delivery')(page).replace('<tbody>\n\n            <tr>',
      '<tbody>\n\n            <tr><td>15-Mar-2026</td><td>09:10 am</td><td>Sample Harbor, Massachusetts 02999</td><td>Delivery Attempted</td></tr>\n            <tr>')),
    IN_TRANSIT);
    expect(refused).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Delivery Attempted', last_update_local: '2026-03-15T09:10:00' });
    expect(refused.events![0]).toMatchObject({ location: 'Sample Harbor, Massachusetts' });
    // A summary behind the newest staged row does not step it back.
    expect(parseAmHomeDelivery(edit('delivered', (page) => page.replace('<span class="info-data"> COMPLETED <!--Token--> </span>',
      '<span class="info-data"> Scheduled <!--Token--> </span>').replace('<li class="actual">', '<li>')), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'COMPLETED', last_update_local: '2026-03-12T16:37:00' });
  });

  it('reads an order without a history as a summary from its status', () => {
    const result = parseAmHomeDelivery(fixture('pending'), PENDING);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Order Received Pending Pickup', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(result).not.toHaveProperty('last_update_local');
    expect(JSON.stringify(result)).not.toMatch(/30000999|Sample Hills|30999|Washer|Washing/);
    // Wording no map or rule stages is kept as the status, without a stage.
    const other = parseAmHomeDelivery(edit('pending', (page) => page.replace('Order Received Pending Pickup', 'Sample Note')
      .replace('<li class="actual">', '<li>')), PENDING);
    expect(other).toMatchObject({ status: 'unknown', last_status_text: 'Sample Note', summary_only: true });
    expect(other).not.toHaveProperty('current_stage');
    expect(() => parseAmHomeDelivery(edit('pending', (page) => page.replace('Order Received Pending Pickup', '')
      .replace('<li class="actual">', '<li>')), PENDING)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the unknown number’s notice as not found, and a shipment only under its own track number', () => {
    expect(() => parseAmHomeDelivery(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAmHomeDelivery(fixture('not-found').replace('Please Enter a Valid BOL Number.', 'Unable to load the order.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page also finds a shipment by its shipper's bill of lading number, which is no answer for the number.
    expect(() => parseAmHomeDelivery(fixture('delivered').replace(`> ${DELIVERED} <`, '> 30000041 <').replace(`> ${DELIVERED_BOL} <`, `> ${UNKNOWN} <`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AM Home Delivery found the number only as a shipper’s bill of lading number' }));
    expect(() => parseAmHomeDelivery(fixture('delivered'), PENDING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AM Home Delivery answered for another shipment' }));
    expect(() => parseAmHomeDelivery(fixture('delivered').replace(`> ${DELIVERED} <`, `> ${DELIVERED}0 <`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseAmHomeDelivery(fixture('in-transit').replace(`> ${IN_TRANSIT} <`, '> am000000123 <'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    for (const change of [
      (page: string) => page.replace(`> ${DELIVERED} <`, '>  <'),
      (page: string) => page.replace('Track Number:', 'Reference:'),
      (page: string) => page.replace('<span class="info-label"> BOL Number: </span>', '<span class="info-label"> Track Number: </span>'),
      (page: string) => page.replace('<h1 class="title">Delivery Status</h1>', '<h1 class="title">Order</h1>'),
      (page: string) => page.replace('id="TrackingDetails"', 'id="Details"'),
      (page: string) => page.replace('<td>12-Mar-2026</td>', '<td>2026-03-12</td>'),
      (page: string) => page.replace('<td>12-Mar-2026</td>', '<td>31-Feb-2026</td>'),
      (page: string) => page.replace('<td>04:37 pm</td>', '<td>16:37</td>'),
      (page: string) => page.replace('<td>04:37 pm</td>', '<td>13:37 pm</td>'),
      (page: string) => page.replace('<td>COMPLETED</td>', '<td></td>'),
      (page: string) => page.replace('<td>COMPLETED</td>', '<td>COMPLETED</td><td>Extra</td>'),
      (page: string) => page.replace('<li class="active">', '<li class="actual">'),
      (page: string) => page.replace(/<tr>\s*<td>12-Mar-2026<\/td>[\s\S]*?<\/tr>/, (row) => row.repeat(301)),
    ]) {
      expect(() => parseAmHomeDelivery(edit('delivered', change), DELIVERED), change.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const page of ['', '<html><body>Tracking Page</body></html>', '{"error":"unexpected"}']) {
      expect(() => parseAmHomeDelivery(page, DELIVERED), page).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A row without a time keeps its day.
    expect(parseAmHomeDelivery(edit('delivered', (page) => page.replace('<td>04:37 pm</td>', '<td></td>')), DELIVERED).events![0])
      .toMatchObject({ local_time: '2026-03-12' });
  });

  it('keeps an unknown number, a moved route, a block page, a wrong redirect and a broken page apart', async () => {
    const lookup = (fetcher: typeof fetch) => carrier(fetcher).track({ number: UNKNOWN });
    await expect(lookup(shipment('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    const once = (first: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => first());
    await expect(lookup(once(() => html('', { status: 404 })))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(serving(() => html('', { status: 410 })))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(serving(() => redirect('https://4301600.app.netsuite.com/app/login/secure/enterpriselogin.nl')))).rejects.toMatchObject({ kind: 'transport' });
    // The lookup's own page in place of its redirect is a block page or a changed site.
    await expect(lookup(once(() => html(CHALLENGE)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(once(() => html('<html><title>AM Home Delivery</title></html>')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(serving(() => html(CHALLENGE)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(serving(() => html(AKAMAI)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(serving(() => html(AKAMAI, { status: 403 })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(serving(() => html('<html><body><p>Notice</p><p>Invalid page parameter. Unable to view page.</p></body></html>', { status: 500 }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // A redirect elsewhere, or to another number, is no answer; nothing is asked of it.
    for (const [location, kind] of [
      [() => 'https://www.example.com/track?number=30000033', 'schema'],
      [(number: string) => pageUrl(number).replace('/scriptlet.nl', '/other.nl'), 'schema'],
      [(number: string) => pageUrl(`${number}0`), 'indeterminate'],
      [(number: string) => `${pageUrl(number)}&number=30000041`, 'indeterminate'],
      [() => '', 'schema'],
    ] as const) {
      const fetcher = serving(() => html(fixture('not-found')), location);
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(amHomeDeliveryPageUrl(`${pageUrl(UNKNOWN)}`, UNKNOWN)).toBe(pageUrl(UNKNOWN));
    expect(() => amHomeDeliveryPageUrl(null, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => amHomeDeliveryPageUrl('http://[', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      for (const fetcher of [vi.fn<typeof fetch>().mockImplementation(async () => html('<html></html>', { status })),
        serving(() => html('<html></html>', { status }))]) {
        await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
        await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      }
    });

  it('recognizes a known number and the unknown notice, and asks nothing for a number AM Home Delivery does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(shipment('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T16:37:00' });
    await expect(carrier(shipment('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(serving(() => html(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A reply for another shipment, or found by a bill of lading number, is no answer either way.
    await expect(carrier(shipment('delivered')).recognize!(PENDING)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!(DELIVERED_BOL)).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers AM Home Delivery does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', DELIVERED_BOL, '300000170', '3000001A', 'AM00000012', 'AM0000001234', 'AB000000123', 'AM00000012X',
      '1452392', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['3000 0017', DELIVERED], ['3000-0017', DELIVERED], ['am000000123', IN_TRANSIT], [' AM 000 000 123', IN_TRANSIT]]) {
      expect(normalizeAmHomeDeliveryNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    // The lookup redirects at once, then the page hangs.
    const lookup = { afterMs: 10, reply: () => redirect(pageUrl(IN_TRANSIT)) };
    const recovered = delayedFetcher([lookup, { afterMs: Infinity }, lookup, { afterMs: 50, reply: () => html(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(260);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(4);
    // Half of the budget for both requests, then the retry within the rest.
    expect(recovered.ended).toEqual([10, 200, 210, 260]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names AM Home Delivery’s to the adapter', async () => {
    const fetcher = shipment('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'am-home-delivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'am-home-delivery', source: 'am-home-delivery', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === amHomeDeliveryLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('AM Home Delivery numbers', () => {
  it('leaves track numbers to the caller’s choice, and reads tracker links', () => {
    // Both shapes are shared or too thinly sampled, so neither detection nor recognition offers AM Home Delivery.
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('am-home-delivery');
      expect(recognitionAskedCarriers(number), number).not.toContain('am-home-delivery');
    }
    for (const [link, number] of [[`https://www.amtrucking.com/track-number.php?cnumber=${DELIVERED}`, DELIVERED],
      [`https://amtrucking.com/track-number.php?cnumber=${IN_TRANSIT}`, IN_TRANSIT],
      ['https://tracking.carrierlogistics.com/scripts/amh.pol/boldetail.htm?wbtn=PRO&wpro1=1000001', '1000001']]) {
      expect(parseTrackingInput(link!), link).toMatchObject({ trackingNumber: number, carrier: 'am-home-delivery', source: 'link' });
    }
  });
});

describe('AM Home Delivery status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(amHomeDeliveryStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // The older tracker's delivery row names the town after its wording.
    expect(amHomeDeliveryStage('DELIVERED; THANK YOU FOR USING AM HOME DELIVERY SAMPLEFORD')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'am-home-delivery', providerCode: null, description: 'Received in Consolidation Center' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'am-home-delivery', providerCode: null, description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    expect(amHomeDeliveryStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(amHomeDeliveryStage('Sample Note')).toBeNull();
  });
});
