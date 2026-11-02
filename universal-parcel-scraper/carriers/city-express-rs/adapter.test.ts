import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CITY_EXPRESS_LOOKUP, CITY_EXPRESS_PAGE, CityExpressTracker, cityExpressLookupUrl } from './adapter.js';
import { cityExpressNumber, parseCityExpress, parseCityExpressPage } from './parser.js';
import { cityExpressMappedStage, cityExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A single parcel's shipment and its parcel.
const DELIVERED = '68800500000001';
const DELIVERED_PARCEL = '6880050000000116';
// A shipment of two parcels: the first carries the shipment's number, the second two more digits.
const SHIPMENT = '68800100000002';
const SECOND_PARCEL = '6880010000000216';
const SERBIAN = '68800200000003';
const UNKNOWN = '68800200000009';
const TOKEN = '00000000-0000-4000-8000-000000000000';
const SESSION = 'JSESSIONID=0000000000000000000000000000ABCD';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = text('page.html');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const page = (body = PAGE, cookies = [`${SESSION}; Path=/; Secure; HttpOnly`], status = 200) => new Response(body, { status,
  headers: [['Content-Type', 'text/html;charset=UTF-8'], ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
/** A site that serves the tracking page, then `lookup` for the fragment. */
const site = (lookup: () => Response, opened: () => Response = () => page()) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url) === CITY_EXPRESS_PAGE ? opened() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('City Express HTTP adapter', () => {
  it('opens the English tracking page, then asks for the fragment with the centre, the eight digits, the session and its token', async () => {
    const fetcher = site(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CityExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 688 005 00000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(CITY_EXPRESS_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(cityExpressLookupUrl('688005', '00000001'));
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ 'track-trace-page-shipment-center': '688005', 'track-trace-page-shipment-number': '00000001' });
    expect(url.startsWith(`${CITY_EXPRESS_LOOKUP}?`)).toBe(true);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', Cookie: SESSION, 'X-CSRF-TOKEN': TOKEN, 'HX-Request': 'true', Referer: CITY_EXPRESS_PAGE } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'city-express-rs', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('sends a parcel’s number as its shipment’s centre and eight digits', async () => {
    const fetcher = site(() => html(text('several-parcels.html')));
    await carrier(fetcher).track({ number: SECOND_PARCEL });
    expect(fetcher.mock.calls[1]![0]).toBe(cityExpressLookupUrl('688001', '00000002'));
  });

  it('keeps each scan’s depot and wall clock, newest first, staged by its wording, and nothing about the sender or recipient', () => {
    const result = parseCityExpress(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-04T10:21:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-04T10:21:00', 'CE Sample Town', 'Delivered', 'delivered'],
      ['2026-03-04T09:20:00', 'CE Sample Town', 'Loaded for Delivery', 'out_for_delivery'],
      ['2026-03-03T17:55:00', 'CE Example City', 'Initialization', 'accepted'],
      ['2026-03-03T10:48:00', 'CE Example City', 'Pickup in progress', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/00000,|SAMPLE TOWN|EXAMPLE CITY|SAMPLE-REF|EXAMPLE\.SHOP/);
    // The shipment's single parcel is the same history.
    expect(parseCityExpress(text('delivered.html'), DELIVERED_PARCEL)).toEqual(result);
  });

  it('reads a shipment of several parcels whole, and a parcel’s number as that parcel alone', () => {
    const whole = parseCityExpress(text('several-parcels.html'), SHIPMENT);
    expect(whole).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-04-15T14:29:00' });
    // The scan both parcels share is kept once.
    expect(whole.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-15T14:29:00', 'Central HUB', 'Delivered', 'delivered'],
      ['2026-04-15T12:16:00', 'CE Example City', 'Deposit in Parcel Terminal', 'ready_for_pickup'],
      ['2026-04-14T21:34:00', 'CE Example City', 'Initialization', 'accepted'],
      ['2026-04-14T15:01:00', 'Central HUB', 'Pickup in progress', 'registered'],
    ]);
    const second = parseCityExpress(text('several-parcels.html'), SECOND_PARCEL);
    expect(second).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-04-15T14:29:00' });
    expect(second.events!.map((event) => event.description)).toEqual(['Delivered', 'Initialization', 'Pickup in progress']);
    // A parcel the shipment does not list is not bound by its reply.
    expect(() => parseCityExpress(text('several-parcels.html'), '6880010000000217'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express listed no parcel with that number' }));
    expect(() => parseCityExpress(text('delivered.html'), '6880050000000117'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express listed no parcel with that number' }));
  });

  it('takes the status above the scans for an ended journey they have not shown, and for a shipment one parcel has not finished', () => {
    const shipment = text('several-parcels.html');
    // One parcel's delivery does not end a shipment whose status is still out for delivery.
    const partial = parseCityExpress(shipment.replace('<span>Delivered</span>', '<span>Na isporuci</span>'), SHIPMENT);
    expect(partial).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Na isporuci',
      last_update_local: '2026-04-15T14:29:00' });
    // The parcel asked for keeps its own scans' stage: the status is its shipment's.
    expect(parseCityExpress(shipment.replace('<span>Delivered</span>', '<span>Na isporuci</span>'), SECOND_PARCEL))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    const delivered = text('out-for-delivery-sr.html').replace('<span>Na isporuci</span>', '<span>Isporučeno</span>');
    expect(parseCityExpress(delivered, SERBIAN)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Isporučeno', last_update_local: '2026-05-15T09:48:00' });
    // A status of the journey's middle leaves the newest scan's stage.
    const loaded = parseCityExpress(text('delivered.html').replace('<span>Delivered</span>', '<span>In transit</span>'), DELIVERED);
    expect(loaded).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    // Without scans, an ended status is a summary and anything else no history.
    const noScans = (status: string) => text('delivered.html').replace('<span>Delivered</span>', `<span>${status}</span>`)
      .replace(/<dl class="row"><p class="mt-0[\s\S]*<\/dl>/, '<dl class="row"></dl>');
    expect(parseCityExpress(noScans('Delivered'), DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true, events: [] });
    expect(() => parseCityExpress(noScans('Loaded for Delivery'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(parseCityExpress(noScans('Delivered').replace(/<p class="lead mt-3">[\s\S]*$/, ''), DELIVERED_PARCEL))
      .toMatchObject({ current_stage: 'delivered', summary_only: true });
  });

  it('reads the Serbian wording and the older layout without parcel numbers', () => {
    const result = parseCityExpress(text('out-for-delivery-sr.html'), SERBIAN);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Utovareno za isporuku', last_update_local: '2026-05-15T09:48:00' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-15T09:48:00', 'CE Primer Grad', 'Utovareno za isporuku', 'out_for_delivery'],
      ['2026-05-14T21:34:00', 'CE Primer Grad', 'Pošiljka uneta u sistem', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIMER GRAD|UZORAK|kg/);
    // A parcel's number cannot be bound to a reply that names no parcel.
    expect(() => parseCityExpress(text('out-for-delivery-sr.html'), `${SERBIAN}16`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express listed no parcel with that number' }));
    // A wording neither the map nor the shared rules know has no stage.
    const unknown = parseCityExpress(text('out-for-delivery-sr.html').replace('Utovareno za isporuku', 'Napomena primer'), SERBIAN);
    expect(unknown).toMatchObject({ current_stage: 'accepted', last_status_text: 'Napomena primer' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker’s notice as not found, in English and in Serbian', async () => {
    expect(() => parseCityExpress(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const serbian = '<p class="lead mb-2">Nema podataka</p><div class="alert alert-primary mt-0 mb-4"><p>Pošiljka sa ovim brojem ne postoji ili još uvek nema status.</p><span>Proverite da li ste ispravno izabrali prefiks <b>688 00X</b>.</span></div>';
    expect(() => parseCityExpress(serbian, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(site(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseCityExpress(text('not-found.html').replace('does not exist', 'could not be loaded'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a reply that prints the shipment asked for', () => {
    expect(() => parseCityExpress(text('delivered.html'), '68800500000004'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express answered for another shipment' }));
    expect(() => parseCityExpress(text('delivered.html'), '68800100000001'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express answered for another shipment' }));
    expect(() => parseCityExpress(text('several-parcels.html').replace('Parcel nr. 688 001 00000002 16', 'Parcel nr. 688 001 00000005 16'), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'City Express answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('tracking-result-title', 'result-title'),
      delivered + delivered,
      delivered.replace('Shipment Nr', 'Number'),
      delivered.replace('688 005 00000001 16</dd>', '688-005-00000001</dd>'),
      delivered.replace('688 005 00000001 16</dd>', '688 005 0000000</dd>'),
      delivered.replace('04.03.2026 10:21', '2026-03-04 10:21'),
      delivered.replace('04.03.2026 10:21', '04.03.2026 24:00'),
      delivered.replace('04.03.2026 10:21', '30.02.2026 10:21'),
      delivered.replace('<span class="ms-2">Delivered</span>', '<span class="ms-2"> </span>'),
      delivered.replace('<span class="ms-2">Delivered</span>', ''),
      delivered.replace('<dt class="col-5 col-md-3">04.03.2026 09:20</dt>', ''),
      delivered.replace('Parcel nr. 688 005 00000001 16', 'Parcel 688 005 00000001 16'),
      delivered.replace('</dl><hr', '<p>Parcel nr. 688 005 00000001 16</p></dl><hr'),
      delivered.replace(/(<p class="mt-0 mb-2">[^<]*<\/p>)([\s\S]*?)(<\/dl><hr)/, (_all, head: string, rows: string, tail: string) => head + rows.repeat(126) + tail),
    ].entries()) {
      expect(() => parseCityExpress(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Scans come under a parcel's number in every place or in none.
    expect(() => parseCityExpress(text('several-parcels.html').replace('<p class="mt-0 mb-2">Parcel nr. 688 001 00000002</p>', ''), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('needs the page’s token and a form that still offers the centre', () => {
    expect(parseCityExpressPage(PAGE, '688005')).toEqual({ header: 'X-CSRF-TOKEN', token: TOKEN });
    for (const changed of [PAGE.replace(TOKEN, 'short'), PAGE.replace('name="_csrf_header" content="X-CSRF-TOKEN"', 'name="_csrf_header" content=""'),
      PAGE.replace('hx-get="/htmx-fragment/shipment-trace-by-number-result"', 'hx-get="/htmx-fragment/other"'),
      PAGE.replace('name="track-trace-page-shipment-number"', 'name="number"'), '<html><body>Sample page</body></html>']) {
      expect(() => parseCityExpressPage(changed, '688005')).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The tracker ignores a centre it does not offer and matches the eight digits alone.
    expect(() => parseCityExpressPage(PAGE.replace('<option value="688005">688 005</option>', ''), '688005'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'City Express tracker no longer offers the centre' }));
    expect(() => parseCityExpressPage(CLOUDFLARE, '688005')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps an unknown number, a refused session, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: () => Response, opened?: () => Response) => carrier(site(body, opened)).track({ number: DELIVERED });
    await expect(lookup(() => html(text('refused.html'), { status: 403 }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.cityexpress.rs/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // The tracking page itself.
    for (const [response, expected] of [
      [() => page(CLOUDFLARE), { kind: 'challenge' }],
      [() => page(CLOUDFLARE, [], 403), { kind: 'challenge', status: 403 }],
      [() => page('', [], 301), { kind: 'transport', status: 301 }],
      [() => page('', [], 404), { kind: 'transport', status: 404 }],
      [() => page(PAGE.replace(TOKEN, 'short')), { kind: 'schema' }],
      [() => page(PAGE, []), { kind: 'indeterminate', reason: 'session_rejected' }],
      [() => page(PAGE, ['JSESSIONID=has space; Path=/']), { kind: 'indeterminate', reason: 'session_rejected' }],
      [() => page(PAGE, ['other=0000000000; Path=/']), { kind: 'indeterminate', reason: 'session_rejected' }],
    ] as const) {
      const fetcher = site(() => html(text('delivered.html')), response);
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject(expected);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the page and from the lookup', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fromLookup).toHaveBeenCalledTimes(2);
      const fromPage = site(() => html(text('delivered.html')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it('refuses what the tracker cannot look up, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The eight digits alone, a centre the tracker does not offer, and other lengths.
    for (const number of ['00000001', '68800300000001', '6880050000000', '688005000000011', '68800500000001166', 'ZZ000000000RS', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(cityExpressNumber(' 688 005 00000001-16 ')).toEqual({ number: DELIVERED_PARCEL, centre: '688005', serial: '00000001', shipment: DELIVERED });
  });

  it('tries an attempt that hangs once more, in a new session, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === CITY_EXPRESS_PAGE)).toBe(true);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(site(() => html(text('delivered.html')))).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(site(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('00000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under City Express to the adapter', async () => {
    const fetcher = site(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'city-express-rs' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'city-express-rs', source: 'city-express-rs', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(CITY_EXPRESS_LOOKUP))).toBe(true);
  });
});

describe('City Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'city-express-rs', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(cityExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'returned to sender')).toBeUndefined();
    expect(cityExpressMappedStage('Delivered')).toBeUndefined();
    expect(cityExpressMappedStage('delivered')).toBe('delivered');
    expect(cityExpressStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(cityExpressStage('Napomena primer')).toBeNull();
    expect(statusMapAnswer({ carrier: 'city-express-rs', providerCode: null, description: 'Napomena primer' })).toEqual({ kind: 'unknown' });
  });
});
