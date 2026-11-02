import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EPARCEL_KR_RESULT, eparcelKrResultUrl, EparcelKrTracker } from './adapter.js';
import { normalizeEparcelKrNumber, parseEparcelKr } from './parser.js';
import { eparcelKrStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'EPH000000011KR';
const DELIVERED = 'ESG000000022KR';
const UNKNOWN = 'EPH000000099KR';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The page the server sends a lookup it could not run to.
const UNKNOWN_ERROR = '<html><body><div id="main"><div id="content"><br /><br /><h2><b>Unknown error.</b></h2><br /><br /></div></div></body></html>';
// One scan row, newest first, as the page writes it.
const row = (clock: string, status: string, explanation: string) => `<tr >\n<td>${clock}</td>\n<td>${status}</td>\n<td>${explanation}</td>\n</tr>\n`;
const withRows = (html: string, change: (rows: string) => string) => html.replace(/(<tbody>)([\s\S]*?)(<\/tbody>)/,
  (_, open: string, rows: string, close: string) => `${open}${change(rows)}${close}`);
const detail = (html: string, label: string, value: string) => html.replace(new RegExp(`(${label} : )[^<\\n]*?(?=\\s*(?:<br|\\n))`), `$1${value}`);
const events = (result: ReturnType<typeof parseEparcelKr>) => result.events!.map((event) => [event.time ?? event.local_time,
  event.provider_code ?? null, event.description, event.stage ?? null, event.location ?? null]);

describe('eParcel Korea HTTP adapter', () => {
  it('opens the result page for the whole number in English, once, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EparcelKrTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' eph 0000-0001-1 kr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EPARCEL_KR_RESULT}?mode=0&ids=${IN_TRANSIT}&branch=00066&lang=en-US`);
    expect(eparcelKrResultUrl('esg-000000022-kr')).toBe(`${EPARCEL_KR_RESULT}?mode=0&ids=${DELIVERED}&branch=00066&lang=en-US`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'eparcel-kr', step: 'direct', outcome: 'ok' }));
  });

  it('reads a flight to the destination newest first, with the Korean leg dated in Korea and later clocks as shown', () => {
    const result = parseEparcelKr(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Aircraft arrival', last_update: null, last_update_local: '2026-10-14T15:20:00',
      expected_delivery: null, destination_country: 'PH',
    });
    expect(events(result)).toEqual([
      ['2026-10-14T15:20:00', '200', 'Aircraft arrival', 'in_transit', 'Example International Airport'],
      ['2026-10-14T02:05:00Z', '100', 'Aircraft departure', 'in_transit', '샘플(Sample International Airport)'],
      ['2026-10-13T09:30:12Z', '30', 'Be released', 'in_transit', null],
      ['2026-10-13T00:41:27Z', '20', 'Completion of the warehousing', 'accepted', null],
      ['2026-10-10T05:02:55Z', '10', 'Ready for warehousing', 'registered', null],
    ]);
    // Ninja Van's adapter takes only its own country-bearing IDs, not eParcel's number.
    for (const field of ['delivery_carrier', 'delivery_tracking_number', 'delivered_at', 'summary_only', 'history_truncated', 'sender_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toMatch(/샘플상사|SAMPLEORDER|warehouse|local time|Republic of Korea/);
  });

  it('reads a delivery with the delivery company’s own lines, and hands the parcel to Janio under its number', () => {
    const result = parseEparcelKr(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Completion of the delivery', last_update: null, last_update_local: '2026-03-06T04:12:33',
      destination_country: 'SG', delivery_carrier: 'janio', delivery_tracking_number: DELIVERED,
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-03-06T04:12:33', '700', 'Completion of the delivery', 'delivered', null],
      ['2026-03-05T23:40:10', '550', 'Currently deliverling: DELIVERY IN PROGRESS', 'in_transit', null],
      ['2026-03-05T10:15:00', '550', 'Currently deliverling: ORDER RECEIVED AT DESTINATION WAREHOUSE', 'in_transit', null],
      ['2026-03-05T08:02:41', '500', 'Start delivery: Order received at local sorting centre.', 'in_transit', null],
      ['2026-03-05T05:30:00', '200', 'Aircraft arrival', 'in_transit', '예시 공항(Example Airport)'],
      ['2026-03-04T10:10:00Z', '100', 'Aircraft departure', 'in_transit', 'Sample International Airport'],
      ['2026-03-04T06:26:15Z', '30', 'Be released', 'in_transit', null],
      ['2026-03-04T02:32:41Z', '20', 'Completion of the warehousing', 'accepted', null],
      ['2026-03-02T02:07:14Z', '10', 'Ready for warehousing', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/샘플스퀘어|용성종합물류|SUCCESS|SAMPLE-0002/);
    expect(deliveryHandoff('eparcel-kr', DELIVERED, result)).toEqual({ carrier: 'janio', number: DELIVERED, basis: 'partner' });
  });

  it('names a delivery company only for a number its tracker takes, and keeps another delivery number on its own', () => {
    const ninja = detail(fixture('in-transit'), 'Delivery No', 'NVPHSAMPLE00000011');
    expect(parseEparcelKr(ninja, IN_TRANSIT)).toMatchObject({ delivery_carrier: 'ninja-van', delivery_tracking_number: 'NVPHSAMPLE00000011' });
    // A company whose link is on another carrier's host, or one the catalog does not know, is not named.
    const elsewhere = ninja.replace("https://www.ninjavan.co/en-my/", 'https://tracker.janio.asia/');
    const unnamed = ninja.replace(/<a [^>]*>NINJAVAN<\/a>/, "<a href='https://courier.example/' target='_blank'>SAMPLE COURIER</a>");
    expect(unnamed).not.toContain('ninjavan');
    for (const html of [elsewhere, unnamed]) {
      const result = parseEparcelKr(html, IN_TRANSIT);
      expect(result).toMatchObject({ delivery_tracking_number: 'NVPHSAMPLE00000011' });
      expect(result).not.toHaveProperty('delivery_carrier');
    }
    // A company named without a link, as older pages print it.
    const plain = fixture('delivered').replace(/<a [^>]*>JANIO<\/a>/, 'JANIO');
    expect(plain).not.toContain('tracker.janio.asia');
    expect(parseEparcelKr(plain, DELIVERED)).toMatchObject({ delivery_carrier: 'janio', delivery_tracking_number: DELIVERED });
    const missing = parseEparcelKr(detail(fixture('delivered'), 'Delivery No', ''), DELIVERED);
    expect(missing).not.toHaveProperty('delivery_carrier');
    expect(missing).not.toHaveProperty('delivery_tracking_number');
  });

  it('dates only the Korean leg’s clocks the page marks local, on a parcel leaving Korea', () => {
    const unmarked = parseEparcelKr(fixture('in-transit').replace('2026-10-13 18:30:12 (local time)', '2026-10-13 18:30:12'), IN_TRANSIT);
    expect(unmarked.events![2]).toMatchObject({ local_time: '2026-10-13T18:30:12', provider_code: '30' });
    expect(unmarked.events![2]).not.toHaveProperty('time');
    const markedArrival = parseEparcelKr(fixture('in-transit').replace('2026-10-14 15:20:00</td>', '2026-10-14 15:20:00 (local time)</td>'), IN_TRANSIT);
    expect(markedArrival.events![0]).toMatchObject({ local_time: '2026-10-14T15:20:00', provider_code: '200' });
    const abroad = parseEparcelKr(detail(fixture('in-transit'), 'Departure country', 'JAPAN'), IN_TRANSIT);
    expect(abroad.events!.every((event) => event.time === undefined && event.local_time)).toBe(true);
    // Older pages write the country in capitals.
    const capitals = parseEparcelKr(detail(fixture('in-transit'), 'Departure country', 'REPUBLIC OF KOREA'), IN_TRANSIT);
    expect(capitals.events![1]).toMatchObject({ time: '2026-10-14T02:05:00Z' });
  });

  it('keeps a code it does not know by its wording, without its explanation, and drops phone numbers from partner lines', () => {
    const added = parseEparcelKr(withRows(fixture('in-transit'), (rows) =>
      `${row('2026-10-15 10:00:00', '[600] Delivered to the recipient', 'Sample Person, 1 Example Street')}${row('2026-10-15 08:00:00', '[550] Currently deliverling', 'Courier 0917-000-0000 is on the way')}${rows}`), IN_TRANSIT);
    expect(events(added).slice(0, 2)).toEqual([
      ['2026-10-15T10:00:00', '600', 'Delivered to the recipient', 'delivered', null],
      ['2026-10-15T08:00:00', '550', 'Currently deliverling: Courier is on the way', 'in_transit', null],
    ]);
    expect(added).toMatchObject({ status: 'delivered', current_stage_source: 'wording:language' });
    expect(JSON.stringify(added)).not.toMatch(/Sample Person|Example Street|0917/);
    const plain = parseEparcelKr(withRows(fixture('in-transit'), (rows) => `${row('2026-10-15 10:00:00', 'Sample status', '')}${rows}`), IN_TRANSIT);
    expect(plain.events![0]).toEqual({ local_time: '2026-10-15T10:00:00', description: 'Sample status' });
    expect(plain).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample status' });
  });

  it('keeps a repeated scan once, and turns an oldest-first history round', () => {
    const repeated = parseEparcelKr(withRows(fixture('in-transit'), (rows) => `${row('2026-10-14 15:20:00', '[200] Aircraft arrival', 'Example International Airport')}${rows}`), IN_TRANSIT);
    expect(repeated.events).toHaveLength(5);
    const reversed = withRows(fixture('in-transit'), (rows) => rows.split(/(?=<tr >)/).reverse().join(''));
    expect(events(parseEparcelKr(reversed, IN_TRANSIT))).toEqual(events(parseEparcelKr(fixture('in-transit'), IN_TRANSIT)));
    expect(() => parseEparcelKr(withRows(fixture('in-transit'), () => ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page’s No data. as not found, and a parcel only when the page names the number asked', () => {
    expect(() => parseEparcelKr(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEparcelKr(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'eParcel Korea answered for another number' }));
    expect(() => parseEparcelKr(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'eParcel Korea answered for another number' }));
    const details = detail(fixture('in-transit'), 'Registration Number', UNKNOWN);
    expect(() => parseEparcelKr(details, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'eParcel Korea answered for another parcel' }));
    // Older pages write "Registration number".
    expect(parseEparcelKr(fixture('in-transit').replaceAll('Registration Number', 'Registration number'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseEparcelKr(UNKNOWN_ERROR, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('id="content"', 'id="main-content"'),
      (html: string) => html.replace('Registration Number : EPH', 'Number : EPH'),
      (html: string) => html.replace('<th>Explanation</th>', '<th>Location</th>'),
      (html: string) => html.replace('More information', 'Details'),
      (html: string) => detail(html, 'Registration Number', ''),
      (html: string) => html.replace('<br />Order number', '<br />Order number : X<br />Order number'),
      (html: string) => html.replace('<br />Order number : SAMPLEORDER0001', '<br />SAMPLEORDER0001'),
      (html: string) => html.replace(/<\/table>/, '</table><table><thead><tr><th>Date</th></tr></thead></table>'),
      (html: string) => html.replace(/(<div id="content">)/, '$1<div class="panel panel-default"></div>'),
      (html: string) => withRows(html, (rows) => `${row('2026-02-30 10:00:00', '[550] Currently deliverling', '')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-15 24:00:00', '[550] Currently deliverling', '')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-15 10:00', '[550] Currently deliverling', '')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-15 10:00:00 (UTC)', '[550] Currently deliverling', '')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-15 10:00:00', '', 'Sample')}${rows}`),
      (html: string) => withRows(html, (rows) => `<tr><td>2026-10-15 10:00:00</td><td>[550] Currently deliverling</td></tr>${rows}`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-01-01 00:00:00', '[10] Ready for warehousing', '').repeat(500)}`),
    ]) {
      expect(() => parseEparcelKr(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>eParcel</body></html>', fixture('not-found').replace('No data.', ''),
      fixture('not-found').replace(/(<div id="content">)/, '$1<div class="panel panel-default"></div>')]) {
      expect(() => parseEparcelKr(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a failed lookup, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: '/Error/UnKnown?aspxerrorpath=/Track/Result' } })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply(UNKNOWN_ERROR))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: '/Account/Login?ReturnUrl=%2f' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>eParcel</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty answer, and asks nothing for a number it does not send', async () => {
    await expect(carrier(page('in-transit')).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-14T02:05:00.000Z' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('EPH00000001KR')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers it does not send and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'EPH00000001KR', 'EPH0000000111KR', 'XPH000000011KR', 'EP0000000011KR', 'EPH000000011JP', 'SAMPLEORDER0001',
      `${IN_TRANSIT},${DELIVERED}`, `${IN_TRANSIT}${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['eph000000011kr', ' EPH 000 000 011 KR ', 'EPH-000000011-KR']) expect(normalizeEparcelKrNumber(raw), raw).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a detected number to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'eparcel-kr', source: 'eparcel-kr', result: { current_stage: 'delivered', delivery_carrier: 'janio' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === eparcelKrResultUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'eparcel-kr', steps: ['direct', 'retry'], recognition: { rank: 624 }, localClocks: true });
  });
});

describe('eParcel Korea numbers', () => {
  it('claims its registration numbers, which leaves nothing to recognize, and reads tracker links', () => {
    for (const number of [IN_TRANSIT, DELIVERED]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'eparcel-kr', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).toEqual([]);
    }
    expect(detectCarrierMatch('EPH00000001KR').carrier).not.toBe('eparcel-kr');
    for (const link of [`https://www.eparcel.kr/Track/Result?mode=0&ids=${IN_TRANSIT}&lang=en-US`,
      `https://eparcel.kr/Track/Result?mode=0&ids=${IN_TRANSIT}&branch=00066`, `https://www.eparcel.kr/Track/MainTracking?num=${IN_TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'eparcel-kr', source: 'link' });
    }
  });
});

describe('eParcel Korea status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(eparcelKrStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'eparcel-kr', providerCode: '700', description: 'Completion of the delivery' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'eparcel-kr', providerCode: '999', description: 'Sample status' })).toEqual({ kind: 'unknown' });
    expect(eparcelKrStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(eparcelKrStage('999', 'Sample status')).toBeNull();
  });
});
