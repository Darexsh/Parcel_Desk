import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LandmarkTracker } from './adapter.js';
import { normalizeLandmarkNumber, parseLandmark } from './parser.js';
import { landmarkStatus } from './status.js';
import metadata from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = 'LTN00000001N1';
const fixture = () => readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const nineDigitFixture = () => readFileSync(new URL('./fixtures/in-transit-nine-digit.html', import.meta.url), 'utf8');
const negative = (number = NUMBER) => `<html><head><title>Landmark Global | Landmark Tracking</title></head><body><input id="search" value="${number}"><div class="error-text">We couldn't find a match for this value. Please try a different value.</div></body></html>`;

describe('Landmark Global history', () => {
  it('binds current nine-digit references and aliases while retaining the full native movement history', () => {
    const result = parseLandmark(nineDigitFixture(), 'LTN000000009');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_update_local: '2026-01-20T12:00:00', last_status_text: 'Departure to country of destination' });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toMatchObject({ stage: 'in_transit', local_time: '2026-01-20T12:00:00' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result).not.toHaveProperty('canonical_tracking_number'); expect(result).not.toHaveProperty('delivered_at');
    expect(parseLandmark(nineDigitFixture(), 'LTN000000009N1')).toMatchObject({ ...result, canonical_tracking_number: 'LTN000000009' });
    for (const entry of statuses.entries) expect(landmarkStatus(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    const different = load(nineDigitFixture()); different('.delivery-details-col h6').last().next('div').text('LTN000000008');
    expect(() => parseLandmark(different.html(), 'LTN000000009')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('binds canonical parcel identity and dates scans by the Central offset the page names beside each', () => {
    const result = normalizeCarrierResult(parseLandmark(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', canonical_tracking_number: 'LTN00000001', last_update: '2026-01-04T12:00:00-06:00', last_update_local: null, expected_delivery: null, delivery_tracking_number: 'AA000000005AU', delivery_carrier: 'australia-post' });
    expect(result.events).toHaveLength(4); expect(result.events?.[0]).toMatchObject({ time: '2026-01-04T12:00:00-06:00', description: 'Delivered', location: 'Example City, EX' });
    expect(result).not.toHaveProperty('delivered_at'); expect(result.events?.every(event => event.time && !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|utc_server_offset|Australia"/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: !!result.events?.length, location: !!result.events?.some(event => event.location),
      delivery_partner: !!result.delivery_carrier, delivery_tracking_number: !!result.delivery_tracking_number,
      canonical_tracking_number: !!result.canonical_tracking_number };
    for (const capability of metadata.capabilities) expect(evidence[capability], capability).toBe(true);
  });
  it.each(['-360', '-300', '0', '330', 'INVALID'])('does not let the current server offset %s change a scan\'s clock', offset => {
    const $ = load(fixture()); $('#utc_server_offset').val(offset);
    expect(parseLandmark($.html(), NUMBER).events).toEqual(parseLandmark(fixture(), NUMBER).events);
  });
  it('dates a clock only by a named offset Chicago keeps then, and otherwise keeps the wall clock', () => {
    const newest = (time: string, shown: string) => {
      const $ = load(fixture()); $('.current-status .time,tbody tr:first-child .time').attr('data-time', time).text(shown);
      return parseLandmark($.html(), NUMBER).events?.[0];
    };
    expect(newest('2026-07-01 08:00:00', 'Wed, Jul 01, 8:00 AM CDT')).toMatchObject({ time: '2026-07-01T08:00:00-05:00' });
    // The hour repeated when Chicago leaves summer time is told apart by its name.
    expect(newest('2026-11-01 01:30:00', 'Sun, Nov 01, 1:30 AM CDT')).toMatchObject({ time: '2026-11-01T01:30:00-05:00' });
    expect(newest('2026-11-01 01:30:00', 'Sun, Nov 01, 1:30 AM CST')).toMatchObject({ time: '2026-11-01T01:30:00-06:00' });
    for (const [time, shown] of [['2026-01-04 12:00:00', 'Sun, Jan 04, 12:00 PM CDT'], ['2026-03-08 02:30:00', 'Sun, Mar 08, 2:30 AM CST'],
      ['2026-01-04 12:00:00', 'Sun, Jan 04, 12:00 PM GMT+1'], ['2026-01-04 12:00:00', 'January 4']] as const) {
      const event = newest(time, shown);
      expect(event, shown).toMatchObject({ local_time: time.replace(' ', 'T') }); expect(event, shown).not.toHaveProperty('time');
    }
  });
  it('accepts the canonical bare identity and rejects other identities and multi-parcel pages', () => {
    expect(parseLandmark(fixture(), 'LTN00000001')).not.toHaveProperty('canonical_tracking_number');
    const wrong = load(fixture()); wrong('.delivery-details-col h6').last().next('div').text('LTN00000002');
    const duplicate = load(fixture()); duplicate('.delivery-details-col').append('<h6>Landmark Tracking Number</h6><div>LTN00000001</div>');
    const twoTables = load(fixture()); twoTables('.event-table').append(twoTables('.event-table table').clone());
    for (const html of [wrong.html(), duplicate.html(), twoTables.html()]) expect(() => parseLandmark(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('binds a merchant reference to the parcel\'s order or package reference and reports its LTN', () => {
    const order = load(fixture()); order('.shipment-details-col div').text('SHOP-000000001');
    const byOrder = parseLandmark(order.html(), 'shop 000000001');
    expect(byOrder).toMatchObject({ status: 'delivered', canonical_tracking_number: 'LTN00000001', delivery_tracking_number: 'AA000000005AU' });
    expect(byOrder.events).toHaveLength(4);
    expect(JSON.stringify(byOrder)).not.toMatch(/SHOP|PRIVATE/);
    const pack = load(fixture()); pack('.shipment-details-col').append('<h6>Package Reference</h6><div class="text-truncate">PK000000002</div>');
    expect(parseLandmark(pack.html(), 'PK000000002')).toMatchObject({ canonical_tracking_number: 'LTN00000001' });
    // The page also finds a parcel by its delivery partner's number, which another carrier hands over.
    const byPartner = parseLandmark(fixture(), 'AA000000005AU');
    expect(byPartner).toMatchObject({ status: 'delivered', canonical_tracking_number: 'LTN00000001' });
    expect(byPartner).not.toHaveProperty('delivery_tracking_number');
    const elsewhere = load(pack.html()); elsewhere('.shipment-details-col h6').last().text('Customer Reference');
    const alias = load(pack.html()); alias('.delivery-details-col h6').last().next('div').text('LTN00000001N1');
    const duplicate = load(pack.html()); duplicate('.delivery-details-col').append('<h6>Landmark Tracking Number</h6><div>LTN00000002</div>');
    for (const html of [fixture(), elsewhere.html(), alias.html(), duplicate.html()]) {
      expect(() => parseLandmark(html, 'PK000000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Only an LTN's absence is final: a reference may have lost punctuation the page needs.
    for (const raw of ['PK000000002', 'pk-0000.00002']) {
      expect(() => parseLandmark(negative('PK000000002'), raw)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
  });
  it('requires exact absence with the requested form identity and never treats challenges as not found', () => {
    expect(() => parseLandmark(negative(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [negative('LTN00000002N1'), negative().replace("We couldn't find a match for this value. Please try a different value.", 'Unavailable'), '<html>Unavailable</html>']) {
      expect(() => parseLandmark(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLandmark(negative().replace('Landmark Global | Landmark Tracking', 'Verify you are human'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLandmark(negative('LTN000000009'), 'LTN000000009')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });
  it('rejects latest-summary mismatches and malformed, absent or excessive history', () => {
    const wording = load(fixture()); wording('.current-status h3').text('Different');
    const date = load(fixture()); date('.current-status .time').attr('data-time', '2026-01-05 12:00:00');
    const empty = load(fixture()); empty('tbody').empty();
    for (const html of [wording.html(), date.html(), empty.html()]) expect(() => parseLandmark(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const malformed = load(fixture()); malformed('tbody tr').eq(1).append('<td>Extra</td>');
    const excessive = load(fixture()); const row = excessive('tbody tr').first().toString(); excessive('tbody').html(row.repeat(501));
    for (const html of [malformed.html(), excessive.html()]) expect(() => parseLandmark(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('retains incomplete or invalid newest clocks as provider text without borrowing older rows', () => {
    const $ = load(fixture()); $('.current-status .time,tbody tr:first-child .time').attr('data-time', '2026-02-30 12:00:00');
    const result = parseLandmark($.html(), NUMBER); expect(result.last_update).toBeNull(); expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30 12:00:00' }); expect(result).not.toHaveProperty('delivered_at');
    $('.current-status .time,tbody tr:first-child .time').attr('data-time', 'Jan 4');
    expect(parseLandmark($.html(), NUMBER).events?.[0]).toMatchObject({ provider_time_text: 'Jan 4' });
  });
  it('preserves invalid local hours literally instead of rolling them into the next day', () => {
    const $ = load(fixture()); $('.current-status .time,tbody tr:first-child .time').attr('data-time', '2026-01-04 24:00:00');
    expect(parseLandmark($.html(), NUMBER).events?.[0]).toMatchObject({ provider_time_text: '2026-01-04 24:00:00' });
    expect(parseLandmark($.html(), NUMBER).events?.[0]).not.toHaveProperty('local_time');
  });
  it('uses only the actual newest wording, preserving unknown stages and completed delivery without summary coercion', () => {
    const $ = load(fixture()); const first = $('tbody tr').first(); first.find('td').first().text('Tendered to Example Gateway'); $('.current-status h3').text('Tendered to Example Gateway');
    expect(parseLandmark($.html(), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Tendered to Example Gateway' });
    expect(parseLandmark($.html(), NUMBER)).not.toHaveProperty('current_stage');
    expect(landmarkStatus('__proto__')).toBeUndefined();
    first.remove(); $('.current-status h3').text('Onboard for delivery'); $('.current-status .time').attr('data-time', $('tbody tr').first().find('.time').attr('data-time'));
    expect(parseLandmark($.html(), NUMBER)).toMatchObject({ status: 'out_for_delivery' });
  });
  it('maps deposit delivery explicitly without exposing the delivery permission', () => {
    const $ = load(fixture());
    const wording = 'Delivered - Delivery / deposit with non-recurring authority';
    $('tbody tr:first-child td').first().text(wording); $('.current-status h3').text(wording);
    const result = parseLandmark($.html(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-01-04T12:00:00-06:00' });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', stage: 'delivered', time: '2026-01-04T12:00:00-06:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(landmarkStatus('One-time recipient permission for deposit')).toBeUndefined();
  });
  it('stages a newest scan in a partner\'s wording by the shared rules', () => {
    const cases: [string, string, string][] = [['Item delivered', 'delivered', 'delivered'], ['Parcel delivered', 'delivered', 'delivered'],
      ['Not Delivered - Addressee not present- Message left', 'exception', 'failed_attempt'],
      ['The item was successfully returned to the sender.', 'exception', 'returned'],
      ['Item arrival at collection point for pick-up', 'out_for_delivery', 'ready_for_pickup'],
      ['Received at Hermes hub', 'in_transit', 'in_transit'], ['Out For Delivery To Courier', 'in_transit', 'in_transit']];
    for (const [wording, status, stage] of cases) {
      const $ = load(fixture()); $('tbody tr:first-child td').first().text(wording); $('.current-status h3').text(wording);
      expect(parseLandmark($.html(), NUMBER), wording).toMatchObject({ status, current_stage: stage, last_status_text: wording });
    }
  });
  it('reads a summary without scan wording: before the first scan has one, and after a return', () => {
    const $ = load(fixture()); $('tbody tr').slice(0, 3).remove(); $('.current-status h2').text('Data Received'); $('.current-status h3').remove();
    $('.current-status .time').attr('data-time', '2026-01-01 12:00:00');
    expect(parseLandmark($.html(), NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    const back = load(fixture()); back('tbody tr').slice(0, 2).remove(); back('.current-status h2').text('Returned');
    back('.current-status h3').html('<a href="/?search=LTN00000002">See return tracking status</a>');
    back('.current-status .time').attr('data-time', '2026-01-03 10:00:00');
    const returned = parseLandmark(back.html(), NUMBER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Customs cleared' });
    expect(JSON.stringify(returned)).not.toContain('LTN00000002');
    back('.current-status h2').text('Complete');
    expect(parseLandmark(back.html(), NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });
  it('reads the delivery partner\'s link and the destination country, never the ship-to town', () => {
    const page = (name: string, action: string, number: string) => {
      const $ = load(fixture());
      $('.delivery-details-col h6').first().next('div').html(`${name} <form class="d-inline" method="GET" action="${action}"><span class="script_allowed"><a href="javascript:;" class="track"> ${number} </a></span><noscript><input type="submit" value="${number}"></noscript></form>`);
      $('.current-status').before('<div class="shipping-details"><h6>Shipping To</h6><p class="light">Exampletown, DE</p><p class="light">Exampletown, DE</p></div>');
      return $.html();
    };
    const hermes = parseLandmark(page('Hermes Parcel', 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation/#H0000000000000000001', 'H0000000000000000001'), NUMBER);
    expect(hermes).toMatchObject({ delivery_carrier: 'hermes-de', delivery_tracking_number: 'H0000000000000000001', destination_country: 'DE' });
    expect(JSON.stringify(hermes)).not.toContain('Exampletown');
    const postal = parseLandmark(page('Postal Carrier', 'https://track.bpost.cloud/btr/web/#/lmg/search?lang=en&itemCodes=AA000000005BE', 'AA000000005BE'), NUMBER);
    expect(postal).toMatchObject({ delivery_tracking_number: 'AA000000005BE' }); expect(postal).not.toHaveProperty('delivery_carrier');
    const own = parseLandmark(page('Final Mile Carrier', 'https://www.example.eu/index.php', 'LTN00000001N1_1234567'), NUMBER);
    expect(own).not.toHaveProperty('delivery_tracking_number'); expect(own).not.toHaveProperty('delivery_carrier');
  });
  it('deduplicates repeated scans and excludes ambiguous delivery partner references', () => {
    const $ = load(fixture()); $('tbody').append($('tbody tr').first().clone());
    expect(parseLandmark($.html(), NUMBER).events).toHaveLength(4);
    $('.delivery-details-col').append('<h6>Delivery Partner</h6><div>Australia Post<form><input name="id" value="AA000000006AU"></form></div>');
    expect(parseLandmark($.html(), NUMBER)).not.toHaveProperty('delivery_tracking_number');
    for (let i = 0; i < 110; i++) { const row = $('tbody tr').first().clone(); row.find('td').last().text(`Example ${i}`); $('tbody').append(row); }
    expect(parseLandmark($.html(), NUMBER).events).toHaveLength(100);
  });
});

describe('Landmark direct retrieval', () => {
  it('keeps detection and normalization aligned for eight- and nine-digit canonical references and aliases', () => {
    const patterns = metadata.detection.map(rule => new RegExp(rule.pattern));
    for (const number of ['LTN00000001', 'LTN00000001N1', 'LTN000000009', 'LTN000000009N1']) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(true);
      expect(normalizeLandmarkNumber(number)).toBe(number);
    }
    for (const number of ['LTN0000000', 'LTN0000000000', 'LTN000000009N2', 'LTN000000009N11']) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(false);
      expect(() => normalizeLandmarkNumber(number)).toThrow(InvalidInputError);
    }
    // Merchant references are the user's choice of carrier, never detection's.
    for (const number of ['PS000000A0000000001', 'SHOP000000001', 'AB345678']) {
      expect(patterns.some(pattern => pattern.test(number)), number).toBe(false);
      expect(normalizeLandmarkNumber(number)).toBe(number);
    }
    // The page searches every merchant: a short value could be another merchant's reference.
    for (const number of ['SHOPPINGS', 'AB34567', 'AB12', `A${'0'.repeat(40)}`, 'SHOP0001/2']) expect(() => normalizeLandmarkNumber(number)).toThrow(InvalidInputError);
  });
  it('forwards the full nine-digit reference and alias without truncating routing digits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(nineDigitFixture()));
    for (const number of ['LTN000000009', 'LTN000000009N1']) {
      await new LandmarkTracker({ fetcher }).fetch(number);
      expect(new URL(String(fetcher.mock.lastCall?.[0])).searchParams.get('search')).toBe(number);
    }
    const reference = load(nineDigitFixture()); reference('.shipment-details-col div').text('SHOP000000001');
    fetcher.mockImplementationOnce(async () => new Response(reference.html()));
    await expect(new LandmarkTracker({ fetcher }).fetch('shop-000000001')).resolves.toMatchObject({ canonical_tracking_number: 'LTN000000009' });
    expect(new URL(String(fetcher.mock.lastCall?.[0])).searchParams.get('search')).toBe('SHOP000000001');
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const number of ['LTN0000000', 'LTN0000000000', 'LTN000000009N2', 'LTN000000009N11']) expect(() => normalizeLandmarkNumber(number)).toThrow(InvalidInputError);
    expect(normalizeLandmarkNumber('ltn-000000009 n1')).toBe('LTN000000009N1');
  });
  it('uses one fresh anonymous GET without a bootstrap or API credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: 'ltn-00000001 n1' }); await instance.track({ number: NUMBER }); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [rawUrl, init] of fetcher.mock.calls) {
      const url = new URL(String(rawUrl)); expect(url.origin + url.pathname).toBe('https://track.landmarkglobal.com/');
      expect(Object.fromEntries(url.searchParams)).toEqual({ search: NUMBER, lang: 'en' });
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' }); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has('Authorization') || new Headers(init?.headers).has('Cookie')).toBe(false);
    }
    expect(normalizeLandmarkNumber('ltn00000001')).toBe('LTN00000001');
  });
  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s distinct from absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) })); await expect(new LandmarkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds invalid inputs, cancellation, fractional deadlines and response size', async () => {
    const unused = vi.fn<typeof fetch>(); await expect(new LandmarkTracker({ fetcher: unused }).fetch(`${NUMBER}&search=other`)).rejects.toThrow(InvalidInputError);
    await expect(new LandmarkTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow(); expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true })); init?.signal?.throwIfAborted(); return new Response(''); });
    await expect(new LandmarkTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001))); await expect(new LandmarkTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
