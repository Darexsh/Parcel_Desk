import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, MAGYAR_POSTA_APP_PAGE, MAGYAR_POSTA_APP_TRACKING, MAGYAR_POSTA_RESULT, MAGYAR_POSTA_SEARCH, MAGYAR_POSTA_TRACKER, MagyarPostaTracker,
  magyarPostaAppTrackingUrl, magyarPostaTrackingUrl } from './adapter.js';
import { normalizeMagyarPostaNumber, parseMagyarPosta, parseMagyarPostaApp } from './parser.js';
import { magyarPostaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'PNZZZ00000013';
const LETTER = 'LZ000000014NL';
const UNKNOWN = 'ZZ000000028HU';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const capture = (overrides: Record<string, unknown> = {}) => ({ url: MAGYAR_POSTA_RESULT, status: 200, headers: {},
  body: fixture('delivered'), truncated: false, base64Encoded: false, error: null, trackingNumberSubmitted: PARCEL, ...overrides });
const searched = (status = 302, error: string | null = null) => ({ url: MAGYAR_POSTA_SEARCH, status, headers: { 'retry-after': '30' },
  body: null, truncated: false, base64Encoded: false, error });
const refused = { url: MAGYAR_POSTA_TRACKER, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false,
  error: 'Google refused the audio challenge' };
const edit = (html: string, change: ($: ReturnType<typeof load>) => void) => { const $ = load(html); change($); return $.html(); };
// The app's API refuses its key, so the tracker's checkbox serves.
const keyRefused = vi.fn(async () => new Response('{"message":"Unauthorized request."}', { status: 403 }));
const tracker = (capturedResponses: unknown[] = [searched(), capture()], statusCode = 200) => {
  const scrape = vi.fn().mockResolvedValue({ tier: 3, statusCode, capturedResponses });
  return { scrape, tracker: new MagyarPostaTracker({ trawl: { scrape } as unknown as TrawlClient, fetcher: keyRefused as unknown as typeof fetch }) };
};
const appFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const APPLICATION = '0a1b2c3d-0000-4000-8000-00000000000e';
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
/** The app's API, which hands out application ids and returns the numbers added under them. */
function appApi(held: Record<string, unknown> = {}, ids = [APPLICATION]) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  let issued = 0;
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: init?.headers as Record<string, string> });
    if (url.pathname.endsWith('/generateApplicationId')) return json({ data: ids[Math.min(issued++, ids.length - 1)] });
    const number = url.searchParams.get('packages[0][packageId]')!;
    return json({ data: held[number] ? [held[number]] : [] });
  });
  return { fetcher, requests, held };
}
const added = (body: unknown, overrides: Record<string, unknown> = {}) => ({ url: MAGYAR_POSTA_APP_TRACKING, status: 200,
  headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), truncated: false,
  base64Encoded: false, error: null, trackingNumberSubmitted: PARCEL, ...overrides });
const widgetRefused = { url: MAGYAR_POSTA_APP_PAGE, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false,
  error: 'Google refused the audio challenge' };
const appTracker = (rows: unknown[] = [added(appFixture('app-delivered'))], held: Record<string, unknown> = {}) => {
  const scrape = vi.fn().mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: rows });
  const api = appApi(held);
  return { scrape, api, tracker: new MagyarPostaTracker({ trawl: { scrape } as unknown as TrawlClient, userAgent: 'synthetic-host/1.0',
    fetcher: api.fetcher as unknown as typeof fetch }) };
};

describe('Magyar Posta result page', () => {
  it('reads a parcel log as wall clocks, newest first, with categories and stages', () => {
    const result = parseMagyarPosta(fixture('delivered'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sikeres kézbesítés rögzítése belső rendszerben', last_update: null,
      last_update_local: '2026-03-03T13:20:00', service_name: 'Üzleti csomag' });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-03-03T13:20:00', '5', 'delivered'],
      ['2026-03-03T13:20:00', '5', 'delivered'],
      ['2026-03-03T07:58:00', '4', 'out_for_delivery'],
      ['2026-03-03T01:05:00', '3', 'in_transit'],
      ['2026-03-02T22:41:00', '1', 'accepted'],
      ['2026-03-02T15:10:00', '1', 'registered'],
    ]);
    expect(result.events![1]).toMatchObject({ description: 'Sikeres kézbesítés rögzítése belső rendszerben',
      location: 'Példavárosi Operatív Osztály, Példaváros' });
    // Who took the item, the cash-on-delivery settlement and a repeated scan stay out.
    expect(JSON.stringify(result)).not.toMatch(/Címzett|Árufizetési/);
    expect(result.events!.some(event => event.time)).toBe(false);
    expect(result.pickup_point).toBeUndefined();
  });

  it('reads a letter, whose placeholder id and unwrapped clocks differ from a parcel, and its pickup office', () => {
    const result = parseMagyarPosta(fixture('pickup'), LETTER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Példaváros 1 posta, Példaváros', last_update_local: '2026-04-11T09:00:00' });
    expect(result.service_name).toBeUndefined();
    expect(result.events!.map(event => event.stage)).toEqual(['ready_for_pickup', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'customs', 'in_transit', 'customs', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events!.at(-2)).not.toHaveProperty('location');
    // Collected later at the same office.
    const collected = edit(fixture('pickup'), $ => {
      $('div.result_item.closed div.fig_24').attr('class', 'fig_25');
      $('div.more_details_container').append(rowFor('2', '5', 'Sikeresen kézbesítve', '2026. 04. 14. 10:31', 'Példaváros 1 posta|Példaváros'));
    });
    expect(parseMagyarPosta(collected, LETTER)).toMatchObject({ current_stage: 'delivered', pickup_point: 'Példaváros 1 posta, Példaváros' });
    // The same scan listed again without its office is one.
    const twice = edit(fixture('pickup'), $ => {
      $('div.more_details_container').append(rowFor('2', '4', 'A küldemény postán átvehető (értesítőn szereplő dátumtól)', '2026. 04. 11. 09:00', ''));
    });
    expect(parseMagyarPosta(twice, LETTER)).toMatchObject({ pickup_point: 'Példaváros 1 posta, Példaváros', events: result.events });
  });

  it('holds back a row dated after the lookup on Budapest time until it is due', () => {
    const planned = edit(fixture('pickup'), $ => {
      $('div.more_details_container').append(rowFor('2', '2', 'Küldemény előkészítése szállításhoz', '2026. 04. 12. 11:40', ''));
    });
    // 10:00 in Budapest, and a quarter of an hour before the row; then a few minutes before it and after it.
    for (const readAt of ['2026-04-11T08:00:00Z', '2026-04-12T09:25:00Z']) {
      expect(parseMagyarPosta(planned, LETTER, Date.parse(readAt))).toMatchObject({ last_update_local: '2026-04-11T09:00:00' });
    }
    for (const readAt of ['2026-04-12T09:36:00Z', '2026-04-12T10:00:00Z']) {
      expect(parseMagyarPosta(planned, LETTER, Date.parse(readAt))).toMatchObject({ last_update_local: '2026-04-12T11:40:00' });
    }
  });

  it('reads a delivery after an undeliverable item went back as its return', () => {
    const html = fixture('delivered').replace('fig_14', 'fig_13').replace('A küldemény a kézbesítőnél van', 'A küldemény nem kézbesíthető (nem kereste)');
    const result = parseMagyarPosta(html, PARCEL);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result.events!.slice(0, 3).map(event => event.stage)).toEqual(['returned', 'returned', 'returned']);
  });

  it('tells a missing number from other answers', () => {
    expect(() => parseMagyarPosta(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notFound = fixture('not-found');
    for (const [html, number, kind] of [
      [notFound, 'ZZ000000031HU', 'schema'],
      [notFound.replaceAll(UNKNOWN, 'ZZ000000031HU').replace(`value="ZZ000000031HU"`, `value="${UNKNOWN}"`), UNKNOWN, 'indeterminate'],
      [notFound.replace('nem talált adatot', 'nem érhető el'), UNKNOWN, 'indeterminate'],
      [notFound.replace('Eredm&#xE9;nyek', 'Results'), UNKNOWN, 'schema'],
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>', UNKNOWN, 'challenge'],
      ['<html><body>Hiba</body></html>', UNKNOWN, 'schema'],
    ] as const) {
      expect(() => parseMagyarPosta(html, number), `${kind} ${html.length}`).toThrow(expect.objectContaining({ kind }));
    }
  });

  it('binds the search, the item and the log to the whole number', () => {
    const page = fixture('delivered');
    expect(() => parseMagyarPosta(page.replace(`value="${PARCEL}"`, `value="${PARCEL},${LETTER}"`), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagyarPosta(page.replace(`data_1 wordwrap">${PARCEL}`, `data_1 wordwrap">${PARCEL}0`), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagyarPosta(page.replace(`data1 wordwrap">${PARCEL}`, `data1 wordwrap">PNZZZ00000026`), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = edit(page, $ => { $('div.result_item.opened').after($('div.result_item.closed').clone()); });
    expect(() => parseMagyarPosta(twice, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const broken of [page.replace('fig_13', 'fig_19'), page.replace('2026. 03. 03. 1:05', '2026. 03. 03. 01:05:00'),
      page.replace('2026. 03. 03. 1:05', '2026. 02. 30. 1:05')]) {
      expect(() => parseMagyarPosta(broken, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an item known by its status alone as a summary', () => {
    const page = fixture('delivered');
    const empty = edit(page, $ => { $('div.more_details_item').remove(); });
    expect(parseMagyarPosta(empty, PARCEL)).toMatchObject({ summary_only: true, current_stage: 'delivered', events: [],
      last_update_local: '2026-03-03T13:20:00' });
  });

  it('accepts the identifiers the tracker takes', () => {
    expect(normalizeMagyarPostaNumber(' pnzzz 0000 0013 ')).toBe(PARCEL);
    expect(magyarPostaTrackingUrl(LETTER)).toBe(`https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=${LETTER}`);
    for (const value of ['PNZZZ', 'ABCDEFGHIJ', 'PNZZZ00000013?', 'A'.repeat(30) + '1']) {
      expect(() => normalizeMagyarPostaNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Magyar Posta app reply', () => {
  it('reads instants, categories and wording, newest first, without names or settlements', () => {
    const result = parseMagyarPostaApp(appFixture('app-delivered'), PARCEL)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sikeresen kézbesítve háznál', last_update: '2026-03-03T12:20:14Z', service_name: 'Üzleti csomag' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-03-03T12:20:14Z', '5', 'delivered'],
      ['2026-03-03T12:20:14Z', '5', 'delivered'],
      ['2026-03-03T06:58:28Z', '4', 'out_for_delivery'],
      ['2026-03-03T00:05:03Z', '3', 'in_transit'],
      ['2026-03-02T21:41:06Z', '1', 'accepted'],
      ['2026-03-02T14:10:01Z', '1', 'registered'],
    ]);
    expect(result.events![1]).toMatchObject({ description: 'Sikeres kézbesítés rögzítése belső rendszerben',
      location: 'Példavárosi Operatív Osztály, Példaváros' });
    expect(result.events![0]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/Példa Feladó|Példa Címzett|jegyzet|\+36|Árufizetési|local_time/);
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('reads a letter waiting at a post office, its categories by name and wording the map does not know', () => {
    const result = parseMagyarPostaApp(appFixture('app-pickup'), LETTER)!;
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Példaváros 1 posta, Példaváros',
      last_status_text: 'A küldemény postán átvehető', service_name: 'Levél', last_update: '2026-04-11T07:00:00Z' });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['4', 'ready_for_pickup'], ['3', 'in_transit'], ['2', 'in_transit'], ['2', 'in_transit'], ['1', 'accepted']]);
  });

  it('reads a scan listed again a second later without its office as one, and a courier assigned as in transit', () => {
    const item = (appFixture('app-pickup').data as Record<string, unknown>[])[0]!;
    const events = item.events as Record<string, unknown>[];
    const waiting = events.at(-1)!;
    const assigned = { alias: 'Kézbesítőhöz rendelve', status: 'Kézbesítés', message: 'Kézbesítőhöz rendelve', code: '4',
      location: '', date: '2026-04-11T05:02:05.000000Z' };
    const twin = { ...waiting, location: '', date: '2026-04-11T07:00:01.000000Z' };
    const result = parseMagyarPostaApp({ data: [{ ...item, events: [...events.slice(0, -1), assigned, waiting, twin] }] }, LETTER)!;
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Példaváros 1 posta, Példaváros', last_update: '2026-04-11T07:00:00Z' });
    expect(result.events!.slice(0, 2).map(event => [event.description, event.stage, event.location ?? null])).toEqual([
      ['A küldemény postán átvehető', 'ready_for_pickup', 'Példaváros 1 posta, Példaváros'], ['Kézbesítőhöz rendelve', 'in_transit', null]]);
    // A placeless scan a minute or more from the placed one is a scan of its own.
    const later = { ...twin, date: '2026-04-11T07:01:00.000000Z' };
    expect(parseMagyarPostaApp({ data: [{ ...item, events: [...events, later] }] }, LETTER)!.events![0]).toMatchObject({ time: '2026-04-11T07:01:00Z' });
  });

  it('holds back the planned leg of a dispatch from abroad until it is due, then keeps its instant', () => {
    const item = (appFixture('app-pickup').data as Record<string, unknown>[])[0]!;
    const events = item.events as Record<string, unknown>[];
    const planned = { alias: 'Küldemény előkészítése szállításhoz', status: 'Feldolgozás', message: 'Küldemény előkészítése szállításhoz',
      code: '2', location: '', date: '2026-04-09T09:40:00.000000Z' };
    const payload = { data: [{ ...item, events: [...events.slice(0, 3), planned] }] };
    const before = parseMagyarPostaApp(payload, LETTER, Date.parse('2026-04-08T12:00:00Z'))!;
    expect(before).toMatchObject({ last_update: '2026-04-08T11:30:00Z' });
    expect(before.events!.map(event => event.time)).toEqual(['2026-04-08T11:30:00Z', '2026-04-08T10:02:00Z', '2026-04-06T09:15:00Z']);
    // Still held back 54 minutes before it is due, as the plan of a lookup at a quarter to the hour.
    expect(parseMagyarPostaApp(payload, LETTER, Date.parse('2026-04-09T08:46:00Z'))).toMatchObject({ last_update: '2026-04-08T11:30:00Z' });
    // A few minutes early, as a clock running ahead, and once due.
    for (const readAt of ['2026-04-09T09:36:00Z', '2026-04-09T10:00:00Z']) {
      expect(parseMagyarPostaApp(payload, LETTER, Date.parse(readAt))!.events![0]).toMatchObject({ time: '2026-04-09T09:40:00Z', stage: 'in_transit' });
    }
  });

  it('answers null for a number the list does not hold, and refuses other replies', () => {
    expect(parseMagyarPostaApp({ data: [] }, PARCEL)).toBeNull();
    expect(parseMagyarPostaApp({ data: [{ ...(appFixture('app-pickup').data as object[])[0] }] }, PARCEL)).toBeNull();
    const item = (appFixture('app-delivered').data as Record<string, unknown>[])[0]!;
    const events = item.events as Record<string, unknown>[];
    for (const payload of [null, [], { data: {} }, { message: 'x' }, { data: [item, item] }, { data: [{ ...item, events: null }] },
      { data: [{ ...item, events: [{ ...events[0], date: '2026-03-02 14:10:01' }] }] },
      { data: [{ ...item, events: [{ ...events[0], date: '2026-03-02T14:10:01+01:00' }] }] },
      { data: [{ ...item, events: [{ ...events[0], message: '', alias: '' }] }] },
      { data: [{ ...item, events: Array.from({ length: 301 }, () => events[1]) }] }]) {
      expect(() => parseMagyarPostaApp(payload, PARCEL), JSON.stringify(payload).slice(0, 60)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // An unknown category keeps the wording's stage without a code; the current state alone is a summary.
    const unknown = parseMagyarPostaApp({ data: [{ ...item, events: [{ ...events[1], status: 'Új' }] }] }, PARCEL)!;
    expect(unknown.events![0]).toMatchObject({ stage: 'accepted' });
    expect(unknown.events![0]).not.toHaveProperty('provider_code');
    expect(parseMagyarPostaApp({ data: [{ ...item, events: [] }] }, PARCEL)).toMatchObject({ summary_only: true, current_stage: 'delivered',
      last_status_text: 'Sikeresen kézbesítve háznál', last_update: null, events: [] });
    expect(() => parseMagyarPostaApp({ data: [{ ...item, events: [], delivery_info: null }] }, PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('Magyar Posta app route', () => {
  it('does not remember its new guest id when TRAWL used a retained registration', async () => {
    const row = added(appFixture('app-delivered'), { headers: { 'x-magyar-posta-registration': 'retained' } });
    const { scrape, api, tracker: active } = appTracker([row]);
    const first = await active.fetch(PARCEL);
    const second = await active.fetch(PARCEL);
    expect(first.current_stage).toBe('delivered'); expect(second.current_stage).toBe('delivered');
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(api.requests.filter(row => row.url.pathname.endsWith('/package/tracking'))).toHaveLength(0);
    expect(JSON.stringify(second)).not.toContain(APPLICATION);
    expect(second).not.toHaveProperty('headers');
  });

  it('lets a cache-aware helper serve a retained registration during its widget refusal cooldown', async () => {
    const refused = { ...widgetRefused, headers: { 'x-magyar-posta-registration-cache': 'memory' } };
    const { scrape, tracker: active } = appTracker([refused]);
    await expect(active.fetch(PARCEL)).rejects.toMatchObject({ reason: 'verification_refused' });
    scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [added(appFixture('app-delivered'), {
      headers: { 'x-magyar-posta-registration': 'retained', 'x-magyar-posta-registration-cache': 'memory' },
    })] });
    expect((await active.fetch(PARCEL)).current_stage).toBe('delivered');
    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it('keeps a retained GET failure distinct from an unadded POST and rejects an unbound cache reply', async () => {
    const failed = appTracker([added({ message: 'Unsuccessful Action!' }, {
      status: 502, headers: { 'x-magyar-posta-registration': 'retained' },
    })]);
    await expect(failed.tracker.fetch(PARCEL)).rejects.toMatchObject({ name: 'UpstreamHttpError', kind: 'indeterminate', status: 502 });
    failed.scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [added(appFixture('app-delivered'), {
      headers: { 'x-magyar-posta-registration': 'retained' },
    })] });
    expect((await failed.tracker.fetch(PARCEL)).current_stage).toBe('delivered');
    expect(failed.scrape).toHaveBeenCalledTimes(2);
    const unbound = appTracker([added(null, { error: 'Magyar Posta returned no bound cached history' })]);
    await expect(unbound.tracker.fetch(PARCEL)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('says what an addition’s reply held when no item is the number’s', async () => {
    const pkg = `${PARCEL}0010000000000`;
    const item = (appFixture('app-delivered').data as Record<string, unknown>[])[0]!;
    for (const [data, message] of [
      [[], 'listed no item'],
      [[{ ...item, package_id: PARCEL }], 'listed the package under its shipment\'s number'],
      [[{ ...item, package_id: LETTER }], 'added the number without returning it'],
    ] as const) {
      const { tracker: active } = appTracker([added({ data }, { trackingNumberSubmitted: pkg })]);
      await expect(active.fetch(pkg)).rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining(message) });
    }
  });

  it('preserves captured rate limits through the TRAWL HTTP envelope', async () => {
    const api = appApi();
    const trawl = new TrawlClient('http://browser.test', async () => json({
      html: '', tier: 3, statusCode: 200, capturedResponses: [added(null, {
        status: 429, headers: { 'retry-after': '7', 'x-magyar-posta-registration': 'retained' },
      })],
    }));
    const active = new MagyarPostaTracker({ trawl, fetcher: api.fetcher as typeof fetch });
    await expect(active.fetch(PARCEL)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
  });

  it('adds a number through the browser service, then reads it again without a token', async () => {
    const { scrape, api, tracker: active } = appTracker();
    expect((await active.fetch(PARCEL, { budgetMs: 40_000 })).current_stage).toBe('delivered');
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: magyarPostaAppTrackingUrl(APPLICATION, PARCEL), skipHttp: true, maxTier: 3,
      captureResponses: [MAGYAR_POSTA_APP_TRACKING] });
    expect(new URL(request.url).searchParams.get('applicationId')).toBe(APPLICATION);
    expect(request.maxTimeout).toBeLessThanOrEqual(38_000);
    expect(options).toMatchObject({ requireSolved: false, captureWindow: 'last', timeoutMs: request.maxTimeout });

    // The list now holds the number, which the same tracker reads under its id.
    api.held[PARCEL] = (appFixture('app-delivered').data as unknown[])[0];
    expect((await active.fetch(PARCEL)).last_update).toBe('2026-03-03T12:20:14Z');
    expect(scrape).toHaveBeenCalledTimes(1);
    const read = api.requests.at(-1)!;
    expect(read.url.origin + read.url.pathname).toBe(MAGYAR_POSTA_APP_TRACKING);
    expect(Object.fromEntries(read.url.searchParams)).toMatchObject({ applicationId: APPLICATION, 'packages[0][packageId]': PARCEL });
    expect(read.headers).toMatchObject({ 'User-Agent': 'synthetic-host/1.0', preview: 'true' });
    expect(read.headers['X-Internal-Key']).toEqual(expect.any(String));
    expect(api.requests.filter(row => row.url.pathname.endsWith('/generateApplicationId'))).toHaveLength(1);
  });

  it('adds a number again once the list no longer holds it, and moves to a fresh id after fifty', async () => {
    const { scrape, api, tracker: active } = appTracker();
    await active.fetch(PARCEL);
    expect((await active.fetch(PARCEL)).current_stage).toBe('delivered');
    expect(scrape).toHaveBeenCalledTimes(2);
    const reads = api.requests.filter(row => row.url.pathname.endsWith('/package/tracking'));
    expect(reads).toHaveLength(1);

    const many = appTracker();
    const numbers = Array.from({ length: 51 }, (_, index) => `PNZZZ${String(index).padStart(7, '0')}`);
    many.scrape.mockImplementation(async (request: { url: string }) => {
      const number = new URL(request.url).searchParams.get('packageId')!;
      const item = { ...(appFixture('app-delivered').data as Record<string, unknown>[])[0], package_id: number };
      return { tier: 3, statusCode: 200, capturedResponses: [added({ data: [item] }, { trackingNumberSubmitted: number })] };
    });
    for (const number of numbers) await many.tracker.fetch(number);
    expect(many.api.requests.filter(row => row.url.pathname.endsWith('/generateApplicationId'))).toHaveLength(2);
  });

  it('keeps refusals, limits, unadded numbers and failures apart', async () => {
    const reply = appFixture('app-delivered');
    for (const [rows, kind] of [
      [[], 'challenge'],
      [[widgetRefused], 'challenge'],
      [[added('{"status":"error","message":"Unsuccessful Action!"}', { status: 502 })], 'indeterminate'],
      [[added('{"status":"error","message":"Unsuccessful Action!"}', { status: 401 })], 'challenge'],
      [[added('', { status: 429, body: null, headers: { 'retry-after': '30' } })], 'rate_limited'],
      [[added('{}', { status: 404 })], 'transport'],
      [[added('{}', { status: 500 })], 'indeterminate'],
      [[added('{}', { status: 503 })], 'maintenance'],
      [[added(reply, { truncated: true })], 'transport'],
      [[added('', { body: null, error: 'Magyar Posta app reply is not JSON' })], 'transport'],
      [[added('', { body: null })], 'schema'],
      [[added({ data: [] })], 'schema'],
      [[added(reply, { trackingNumberSubmitted: 'PNZZZ00000026' })], 'challenge'],
      [[added(reply), added(reply)], 'challenge'],
    ] as const) {
      await expect(appTracker([...rows]).tracker.fetch(PARCEL), `${kind} ${JSON.stringify(rows).slice(0, 90)}`)
        .rejects.toMatchObject({ kind });
    }
  });

  it('does not ask again for a while after Google refuses the widget or the app does not add the number', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const refused = appTracker([widgetRefused]);
      await expect(refused.tracker.fetch(PARCEL)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_refused' });
      await expect(refused.tracker.fetch(LETTER)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_refused' });
      expect(refused.scrape).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 10 * 60_000);
      refused.scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [added(appFixture('app-delivered'))] });
      expect((await refused.tracker.fetch(PARCEL)).current_stage).toBe('delivered');

      now.mockReturnValue(1_000_000);
      const unadded = appTracker([added('{"status":"error","message":"Unsuccessful Action!"}', { status: 502 })]);
      for (let i = 0; i < 2; i++) await expect(unadded.tracker.fetch(PARCEL)).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(unadded.scrape).toHaveBeenCalledTimes(1);
      // Another number is still asked, here without a reply bound to it, and this one after half an hour.
      await expect(unadded.tracker.fetch('PNZZZ00000026')).rejects.toMatchObject({ kind: 'challenge' });
      now.mockReturnValue(1_000_000 + 30 * 60_000);
      await expect(unadded.tracker.fetch(PARCEL)).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(unadded.scrape).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });

  it('falls back to the tracker only when the app refuses its key, and keeps the app\'s limits', async () => {
    const scrape = vi.fn().mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [searched(), capture()] });
    const trawl = { scrape } as unknown as TrawlClient;
    expect((await new MagyarPostaTracker({ trawl, fetcher: keyRefused as unknown as typeof fetch }).fetch(PARCEL)).current_stage).toBe('delivered');
    expect(scrape.mock.calls[0]![0]).toMatchObject({ url: magyarPostaTrackingUrl(PARCEL) });
    for (const [fetcher, kind] of [
      [async () => json({}, 429, { 'retry-after': '60' }), 'rate_limited'],
      [async () => { throw new TypeError('fetch failed'); }, 'transport'],
      [async () => json({ data: 'PRIVATE' }), 'schema'],
      [async () => new Response('<html></html>', { status: 200 }), 'schema'],
    ] as const) {
      scrape.mockClear();
      await expect(new MagyarPostaTracker({ trawl, fetcher: fetcher as unknown as typeof fetch }).fetch(PARCEL)).rejects.toMatchObject({ kind });
      expect(scrape).not.toHaveBeenCalled();
    }
    // A refused tracker checkbox does not hold the app's widget back.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      let refusing = true;
      const api = appApi();
      const both = new MagyarPostaTracker({ trawl, fetcher: (async (input: string, init?: RequestInit) => refusing
        ? keyRefused() : api.fetcher(input, init)) as unknown as typeof fetch });
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [refused] });
      await expect(both.fetch(PARCEL)).rejects.toMatchObject({ reason: 'verification_refused' });
      refusing = false;
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [added(appFixture('app-delivered'))] });
      expect((await both.fetch(PARCEL)).current_stage).toBe('delivered');
    } finally { now.mockRestore(); }
  });
});

describe('Magyar Posta status map', () => {
  it('stages every recorded wording, its category otherwise, and leaves settlements out', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(stage);
    }
    expect(magyarPostaStage('3', 'Új esemény')).toBe('in_transit');
    expect(magyarPostaStage('4', 'Új esemény')).toBeUndefined();
    expect(magyarPostaStage('9', 'Új esemény')).toBeUndefined();
    expect(magyarPostaStage(null, 'Sikeresen kézbesítve')).toBe('delivered');
    for (const code of ['constructor', '__proto__', 'toString']) expect(magyarPostaStage(code, 'új esemény')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'magyar-posta', providerCode: '5', description: 'Feladónak visszakézbesítve' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'magyar-posta', providerCode: '5', description: 'Árufizetési összeg feladónak kifizetve' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});

describe('Magyar Posta tracker search', () => {
  it('asks the browser service for the public page and its bound result within the budget', async () => {
    const { scrape, tracker: active } = tracker();
    expect((await active.fetch(PARCEL, { budgetMs: 40_000 })).current_stage).toBe('delivered');
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: magyarPostaTrackingUrl(PARCEL), skipHttp: true, maxTier: 3, captureResponses: [MAGYAR_POSTA_RESULT] });
    expect(request.maxTimeout).toBeLessThanOrEqual(38_000);
    expect(options).toMatchObject({ requireSolved: false, captureWindow: 'last', timeoutMs: request.maxTimeout });
    await expect(tracker([searched(), capture({ body: fixture('not-found'), trackingNumberSubmitted: UNKNOWN })]).tracker.fetch(UNKNOWN))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, limits and failures apart from a missing number', async () => {
    for (const [rows, statusCode, kind] of [
      [[], 200, 'challenge'],
      [[], 429, 'rate_limited'],
      [[], 503, 'maintenance'],
      [[], 404, 'transport'],
      [[searched(200, 'Magyar Posta refused the verification')], 200, 'challenge'],
      [[refused], 200, 'challenge'],
      [[{ ...refused, error: 'other' }], 200, 'challenge'],
      [[searched(429)], 200, 'rate_limited'],
      [[searched(403)], 200, 'challenge'],
      [[searched(500)], 200, 'indeterminate'],
      [[searched()], 200, 'transport'],
      [[searched(), capture({ trackingNumberSubmitted: 'PNZZZ00000026' })], 200, 'transport'],
      [[searched(), capture({ url: `${MAGYAR_POSTA_RESULT}?x` })], 200, 'transport'],
      [[searched(), capture({ status: 502 })], 200, 'indeterminate'],
      [[searched(), capture({ status: 404 })], 200, 'transport'],
      [[searched(), capture({ truncated: true })], 200, 'transport'],
      [[searched(), capture({ body: null })], 200, 'transport'],
      [[searched(), capture({ error: 'Magyar Posta response could not be read' })], 200, 'transport'],
      [[searched(), capture({ body: 'x'.repeat(1_000_001) })], 200, 'schema'],
      [Array.from({ length: 11 }, () => searched()), 200, 'challenge'],
    ] as const) {
      await expect(tracker([...rows], statusCode).tracker.fetch(PARCEL), `${kind} ${JSON.stringify(rows).slice(0, 80)}`)
        .rejects.toMatchObject({ kind });
    }
  });

  it('fails as a challenge without the browser for a while after Google refuses the audio challenge', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const { scrape, tracker: active } = tracker([refused]);
      await expect(active.fetch(PARCEL)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_refused' });
      await expect(active.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_refused' });
      expect(scrape).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 10 * 60_000);
      scrape.mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [searched(), capture()] });
      expect((await active.fetch(PARCEL)).current_stage).toBe('delivered');
      // An unsolved checkbox is no refusal of the address.
      const unsolved = tracker([]);
      for (let i = 0; i < 2; i++) await expect(unsolved.tracker.fetch(PARCEL)).rejects.toMatchObject({ kind: 'challenge' });
      expect(unsolved.scrape).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });

  it('needs the browser service, a usable number and budget', async () => {
    await expect(new MagyarPostaTracker().fetch(PARCEL)).rejects.toMatchObject({ kind: 'challenge' });
    const { scrape, tracker: active } = tracker();
    await expect(active.fetch('PNZZZ')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(active.fetch(PARCEL, { budgetMs: 1500 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(active.fetch(PARCEL, { signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('declares its browser step', () => {
    const instance = adapter({ trawl: null } as never);
    expect(instance).toMatchObject({ id: 'magyar-posta', steps: ['app', 'trawl'], recordsSteps: true });
    expect(instance.recognize).toBeUndefined();
    expect(instance.recognizeWithBrowser).toEqual(expect.any(Function));
  });

  it('is asked first in browser recognition for its own S10 items and MPL numbers, never over HTTP', async () => {
    for (const number of ['RB472618350HU', 'PNZZZ58204711']) {
      expect(recognitionCandidates(number).map((candidate) => candidate.carrier)).not.toContain('magyar-posta');
      expect(recognitionCandidates(number, { phase: 'browser' })[0]).toMatchObject({ carrier: 'magyar-posta', needsInput: null });
    }
    expect(recognitionCandidates('RB472618351HU', { phase: 'browser' }).map((candidate) => candidate.carrier)).not.toContain('magyar-posta');
    expect(recognitionCandidates('RB472618350HR', { phase: 'browser' }).map((candidate) => candidate.carrier)).not.toContain('magyar-posta');

    // The app's scans are instants, which confirm the number and come back for reuse.
    const scrape = vi.fn().mockResolvedValue({ tier: 3, statusCode: 200, capturedResponses: [added(appFixture('app-delivered'))] });
    const api = appApi();
    const app = adapter({ trawl: { scrape }, fetcher: api.fetcher, userAgent: 'synthetic-host/1.0' } as never);
    const known = await app.recognizeWithBrowser!(PARCEL, { budgetMs: 40_000 });
    expect(known).toMatchObject({ known: true, lastActivityAt: '2026-03-03T12:20:14.000Z' });
    expect(known.result?.current_stage).toBe('delivered');

    // The tracker's wall clocks name no instant, so its answer confirms nothing.
    const web = tracker();
    const page = adapter({ trawl: { scrape: web.scrape }, fetcher: keyRefused } as never);
    expect(await page.recognizeWithBrowser!(PARCEL, { budgetMs: 40_000 })).toEqual({ known: false, lastActivityAt: null });
  });
});

function rowFor(tab: string, category: string, wording: string, time: string, place: string): string {
  return `<div class="more_details_item light">\n<div class="status_ikon blue">\n<div class="fig_${tab}${category}"></div>\n</div>\n`
    + `<div class="line_container">\n<div class="data_txt data_more_2"><div>Kézbesített</div></div>\n`
    + `<div class="data_txt data_more_3">\n<div>${wording}<br /><span class="data_sikertelen_atv">Címzett</span></div>\n</div>\n`
    + `<div class="data_txt data_more_1">${time}</div>\n<div class="data_txt data_more_4"><div>${place}</div></div>\n</div>\n</div>\n`;
}
