import { load } from 'cheerio';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, StCourierTracker } from './adapter.js';
import { normalizeStCourierNumber, parseStCourier, ST_COURIER_CHECK, ST_COURIER_RESULT, stCourierWording } from './parser.js';
import { stCourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '90000000011';
const IN_TRANSIT = '90000000022';
const BOOKED = '90000000033';
const UNKNOWN = '90000000099';
const SESSION = 'ci_session=syntheticsession00000000000000000';
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const pages: Record<string, string> = { [DELIVERED]: 'delivered', [IN_TRANSIT]: 'in-transit', [BOOKED]: 'booked' };
/** The result page for a number: its fixture, else the not-found page naming it. */
const resultFor = (number: string) => pages[number] ? page(pages[number]) : page('not-found').replaceAll(UNKNOWN, number);
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
// The lookup answers JSON under an HTML content type and opens the session with its cookie.
const filed = (body: unknown = { code: 200, msg: 'Track Shipment' }, cookies = [`${SESSION}; expires=Thu, 01-Jan-2099 00:00:00 GMT; Max-Age=600; path=/; HttpOnly; SameSite=Lax`]) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: [['Content-Type', 'text/html; charset=UTF-8'], ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** ST Courier's tracker: the lookup files the number in the session, and the result page shows it. */
function site(result: (number: string) => Response = (number) => html(resultFor(number)), lookup: () => Response = () => filed()) {
  let asked = '';
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === ST_COURIER_CHECK) {
      asked = new URLSearchParams(String(init!.body)).get('awb_no')!;
      return lookup();
    }
    return result(asked);
  });
}

const edited = (name: string, change: (body: string) => string) => change(page(name));

describe('ST Courier tracking adapter', () => {
  it('posts the number to the tracking form’s lookup, then opens the result page in its session, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[checkUrl, checkInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(checkUrl).toBe('https://stcourier.com/track/doCheck');
    expect(checkInit).toMatchObject({ method: 'POST', body: `awb_no=${IN_TRANSIT}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(checkInit.headers).not.toHaveProperty('Cookie');
    expect(url).toBe('https://stcourier.com/track/shipment');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'st-courier', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivery from its scans at UTC+5:30, newest first, past the summary the page fills in without a booking', () => {
    const result = parseStCourier(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T14:39:00Z', delivered_at: '2026-03-05T14:39:00Z',
      expected_delivery: null, timezone: 'Asia/Kolkata' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-03-05T14:39:00Z', null, 'Delivered', 'delivered'],
      // Just after midnight in India, the evening before in UTC.
      ['2026-03-03T18:45:00Z', null, 'Forwarded to SMP', 'in_transit'],
      ['2026-03-03T18:10:00Z', 'Samplepur hub, TN', 'Received at Hub', 'in_transit'],
      ['2026-03-02T13:17:00Z', 'Exampleton hub, KA', 'Received at Hub', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
    // Who took the parcel and the phone number after it stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|9876543210|MR\./);
  });

  it('takes a booked summary’s delivery and its delivery time over a sparse history, and keeps its branches and kind out', async () => {
    const result = await carrier(site()).track({ number: BOOKED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-06T14:39:00Z', delivered_at: '2026-03-06T14:39:00Z' });
    expect(result.events).toEqual([{ time: '2026-03-03T02:28:00Z', location: 'Exampleton hub, KA', description: 'Received at Hub',
      stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(JSON.stringify(result)).not.toMatch(/TNSMP|KAEXM|NDx|Nos/);
  });

  it('reads a booked summary without scans as a summary, and an unbooked one without scans as no history', () => {
    const empty = (name: string) => {
      const $ = load(page(name));
      $('.tl19').remove();
      return $.html();
    };
    expect(parseStCourier(empty('booked'), BOOKED)).toEqual({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: 'Delivered', last_update: '2026-03-06T14:39:00Z', expected_delivery: null,
      delivered_at: '2026-03-06T14:39:00Z', timezone: 'Asia/Kolkata', summary_only: true, events: [] });
    expect(() => parseStCourier(empty('in-transit'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('lets the scans decide when a booked summary is not a delivery or a return', () => {
    const result = parseStCourier(edited('booked', (body) => body.replace('>Delivered</td>', '>In Transit</td>')
      .replace('Received at Hub<br>', 'Taken For Delivery<br>')), BOOKED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Taken For Delivery',
      last_update: '2026-03-03T02:28:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps only a branch or hub with its state as the place, and drops phone numbers from wordings', () => {
    const result = parseStCourier(edited('in-transit', (body) => body.replace('Samplepur hub, TN', 'SAMPLE PERSON')), IN_TRANSIT);
    expect(result.events!.map((event) => event.location ?? null)).toEqual([null, null]);
    expect(stCourierWording('Forwarded to SMP 98765 43210')).toBe('Forwarded to SMP');
    expect(stCourierWording('Delivered to SAMPLE PERSON')).toBe('Delivered');
  });

  it('reads a parcel in transit', async () => {
    const result = await carrier(site()).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Forwarded to EXM',
      last_update: '2026-10-21T06:46:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location ?? null])).toEqual([
      ['2026-10-21T06:46:00Z', null],
      ['2026-10-20T15:33:00Z', 'Samplepur hub, TN'],
    ]);
  });

  it('reads the page’s answer naming the number as not found, and one naming another number as inconclusive', async () => {
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(() => html(page('not-found')))).track({ number: '90000000098' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds the result page to the whole number asked', () => {
    expect(() => parseStCourier(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStCourier(edited('delivered', (body) => body.replace(`value="${DELIVERED}"`, `value="${IN_TRANSIT}"`)), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStCourier(edited('delivered', (body) => body.replace(`font-normal">${DELIVERED}`, `font-normal">${DELIVERED}1`)), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a session that holds no lookup apart from a missing parcel', async () => {
    const blank = edited('not-found', (body) => body.replace(/<h4 class="text-danger">[^<]*<\/h4>/, ''));
    await expect(carrier(site(() => html(blank))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    const withoutCookie = site(undefined, () => filed(undefined, []));
    await expect(carrier(withoutCookie).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(withoutCookie).toHaveBeenCalledTimes(1);
  });

  it('reads a bot check in place of the lookup or the page, or a refusal, as a challenge', async () => {
    const checked = site(undefined, () => html(CHECK));
    await expect(carrier(checked).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(checked).toHaveBeenCalledTimes(1);
    await expect(carrier(site(() => html(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => html('<html><body>Forbidden</body></html>', { status: 403 }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(undefined, () => html('', { status: 403 }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reports a rate limit without the session the request carried', async () => {
    const error = await carrier(site(() => html('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } })))
      .track({ number: DELIVERED }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect((error as { request?: unknown }).request).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('syntheticsession');
  });

  it('keeps a moved route and a failed lookup apart from an unknown number', async () => {
    await expect(carrier(site(undefined, () => new Response('', { status: 302, headers: { Location: 'https://stcourier.com/' } })))
      .track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => new Response('', { status: 302, headers: { Location: 'https://stcourier.com/' } })))
      .track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => html('', { status: 404 }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(undefined, () => filed({ code: 500, msg: '<p>Something went wrong.</p>' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects malformed replies and pages', async () => {
    for (const reply of ['', '<html><body>Error</body></html>', '{"msg":"Track Shipment"}', '[200]']) {
      await expect(carrier(site(undefined, () => filed(reply))).track({ number: DELIVERED }), reply).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(carrier(site(() => html('<html><title>ST COURIER</title></html>'))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    for (const body of [
      edited('delivered', (text) => text.replace('Mar 05, 2026<br>', 'Mar 32, 2026<br>')),
      edited('delivered', (text) => text.replace('08:09 PM', '20:09')),
      edited('delivered', (text) => text.replace('Mar 05, 2026<br>08:09 PM', '05-03-2026 20:09')),
      edited('delivered', (text) => text.replace('Forwarded to SMP<br>', '<br>')),
      edited('delivered', (text) => text.replace(/<div class="\w+ info"[^>]*><i class="fa fa-link"><\/i><\/div>/, '')),
      edited('delivered', (text) => text.replace('Delivery Status', 'Booking')),
      edited('booked', (text) => text.replace('06-03-2026 8:09 PM', '31-02-2026 8:09 PM')),
      edited('booked', (text) => text.replace('<td>Orgin SRC</td>', '<td>Orgin SRC</td><td>Extra</td>')),
      edited('booked', (text) => text.replace('<td>Destination </td>', '<td>Orgin SRC</td>')),
    ]) expect(() => parseStCourier(body, body.includes(BOOKED) ? BOOKED : DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses numbers the tracker does not take before any request, and its own refusal of one', async () => {
    const fetcher = site();
    for (const number of ['', '9000000001', '900000000111', '01111111111', '011171418743', 'A0000000011', '90000000011,90000000022', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStCourierNumber('900-0000-0011')).toBe(DELIVERED);
    const refused = site(undefined, () => filed({ code: 400, msg: '<p>The AWB Number field is not in the correct format.</p>\n' }));
    await expect(carrier(refused).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a network failure, in a fresh session', async () => {
    const answers = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(answers);
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([ST_COURIER_CHECK, ST_COURIER_CHECK, ST_COURIER_RESULT]);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('recognizes a known consignment with its last scan, an unknown one, and asks nothing for a number it does not take', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-21T06:46:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('011171418743')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('routes a number filed under ST Courier to the adapter, and leaves eleven digits to the caller', async () => {
    const answer = await createTracker({ fetcher: site(), providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'st-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'st-courier', source: 'st-courier', result: { current_stage: 'delivered' } });
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('st-courier');
      expect(recognitionAskedCarriers(number), number).not.toContain('st-courier');
    }
  });
});

describe('ST Courier status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(stCourierStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'st-courier', providerCode: null, description: 'Received at Hub' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(stCourierStage('RTO Delivered')?.stage).toBe('returned');
    expect(stCourierStage('RTO In Transit')?.stage).toBe('exception');
    expect(statusMapAnswer({ carrier: 'st-courier', providerCode: null, description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});
