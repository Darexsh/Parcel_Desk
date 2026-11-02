import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_KENYA_TRACK, PostaKenyaTracker } from './adapter.js';
import { normalizePostaKenyaNumber, parsePostaKenyaAnswer, parsePostaKenyaResult, postaKenyaFormFields } from './parser.js';
import { postaKenyaStage, postaKenyaWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'EE000000014KE';
const INBOUND = 'CP000000005DE';
const UNKNOWN = 'RR000000005KE';
const RESULT = 'https://postglobal.posta.co.ke/postglobaltrack/TrackResult.aspx?type=I';
const SESSION = 'syntheticSession0000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The form's answer echoes the code in its field.
const answer = (name: 'answer' | 'not-found', number: string) => page(name).replace(/value="[A-Z0-9]{13}" maxlength/, `value="${number}" maxlength`);
const html = (body: string, status = 200, cookies: string[] = []) => new Response(body, { status,
  headers: [['content-type', 'text/html; charset=utf-8'], ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
const opened = [`ASP.NET_SessionId=${SESSION}; path=/; HttpOnly; SameSite=Lax`];
type Step = (number: string) => Response | Promise<Response>;
/** The tracker: its form, the form's answer for the posted code, and the result page. */
const site = (steps: { form?: Step; lookup?: Step; result?: Step } = {}) => vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  if (init?.method === 'POST') {
    const number = new URLSearchParams(String(init.body)).get('txtID') ?? '';
    return steps.lookup ? steps.lookup(number) : html(answer(number === UNKNOWN ? 'not-found' : 'answer', number), 200,
      number === UNKNOWN ? [] : opened);
  }
  if (url === POSTA_KENYA_TRACK) return steps.form ? steps.form('') : html(page('form'));
  if (url === RESULT) return steps.result ? steps.result('') : html(page('delivered'));
  return html('<html><body>Not found</body></html>', 404);
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const ERROR_PAGE = '<html><head><title>Runtime Error</title></head><body><h1>Server Error in \'/PostGlobalTrack\' Application.</h1></body></html>';
type Details = { request?: unknown; diagnostics?: unknown };
const edited = (name: string, change: (html: string) => string) => change(page(name));

describe('Posta Kenya tracking adapter', () => {
  it('opens the form, posts the whole code with its state and reads the result in the session the answer opened', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaKenyaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ee 000 000 014 ke ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `GET ${POSTA_KENYA_TRACK}`, `POST ${POSTA_KENYA_TRACK}`, `GET ${RESULT}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init!.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    }
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has('cookie')).toBe(false);
    const post = fetcher.mock.calls[1]![1]!;
    expect(new Headers(post.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(new Headers(post.headers).has('cookie')).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(String(post.body)))).toEqual({
      __EVENTTARGET: '', __EVENTARGUMENT: '', __VIEWSTATE: expect.stringMatching(/^\/wEPDwUKA+==$/), __VIEWSTATEGENERATOR: '00000000',
      __EVENTVALIDATION: expect.stringMatching(/^\/wEdA+==$/), txtID: DELIVERED, 'ImgBtnTrack.x': '0', 'ImgBtnTrack.y': '0' });
    expect(new Headers(fetcher.mock.calls[2]![1]!.headers).get('cookie')).toBe(`ASP.NET_SessionId=${SESSION}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-kenya', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item posted in Kenya and delivered abroad, newest first, without anyone’s details', () => {
    const result = parsePostaKenyaResult(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-04-08T10:15:00', expected_delivery: null,
      destination_country: 'SE' });
    // A delivery abroad keeps its wall clock, so it gives no instant.
    expect(result).not.toHaveProperty('delivered_at');
    // The repeated scan is kept once, and an office written as a postcode is dropped.
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-04-08T10:15:00', null, 'Delivered', 'delivered'],
      ['2026-04-06T14:36:00', null, 'Undelivered: ADDRESSEE NOT AVAILABLE AT TIME OF DELIVERY; ITEM BEING HELD, ADDRESSEE BEING NOTIFIED',
        'failed_attempt'],
      ['2026-03-17T11:05:00', 'SAMPLE AIR MAIL UNIT, Sweden', 'Shipment returned by customs', 'in_transit'],
      ['2026-03-16T09:32:00', 'SAMPLE AIR MAIL UNIT, Sweden', 'Received at Exchange office for delivery', 'in_transit'],
      ['2026-03-16T09:32:00', 'SAMPLE AIR MAIL UNIT, Sweden', 'With Customs', 'customs'],
      // A scan the page places in Kenya is on Nairobi's clock.
      ['2026-03-03T09:52:00+03:00', 'SAMPLE EXCHANGE, Kenya', 'Received at Exchnage office for dispatch', 'in_transit'],
      ['2026-03-02T12:51:00', 'SAMPLE OFFICE', 'Dispatched', 'in_transit'],
      ['2026-03-02T10:54:00', 'SAMPLE OFFICE', 'Received the Shipment from customer', 'accepted'],
    ]);
    expect(result.events!.filter((event) => event.time).length).toBe(1);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // The sender, the addressee, who signed, their identity document and the summary's delivery line are not read.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SENDER|SAMPLE ADDRESSEE|SAMPLE SIGNER|SAMPLE ID|Signed by|ID No|00000|BOX/);
  });

  it('reads mail from abroad on its way in Kenya, with each place’s first line only', async () => {
    const fetcher = site({ result: () => html(page('inbound')) });
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received the item',
      last_update: null, last_update_local: '2026-04-07T15:00:00', destination_country: 'KE' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.description])).toEqual([
      ['2026-04-07T15:00:00', 'SAMPLE GPO', 'Received the item'],
      ['2026-04-07T14:54:00', 'SAMPLE GPO', 'Received at location'],
      ['2026-04-06T15:20:00', 'SAMPLE OFFICE', 'Bagged'],
      ['2026-04-06T13:21:00', 'SAMPLE OFFICE', 'Received the item'],
      ['2026-04-06T13:10:00+03:00', 'SAMPLE EXCHANGE, Kenya', 'Received at Exchange office for delivery'],
      ['2026-03-23T12:23:00', 'SAMPLE INTERNATIONAL, Germany', 'Received at Exchnage office for dispatch'],
      // The origin office's number is dropped.
      ['2026-03-20T16:23:00', null, 'Received the Shipment from customer'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Received from|Bagged to|DE00000/);
  });

  it('reads places, wording and clocks the way the page gives them', () => {
    const scan = (change: (html: string) => string) => parsePostaKenyaResult(edited('inbound', change), INBOUND).events![0]!;
    // A bracket that names no country stays part of the office; the newest scan sets the status even without a stage.
    expect(scan((text) => text.replace('<td width="40%">SAMPLE GPO<br>Received from SAMPLE OFFICE</td>',
      '<td width="40%">SAMPLE ISC (USPS) (United States of America)</td>'))).toMatchObject({ location: 'SAMPLE ISC (USPS), United States of America' });
    expect(scan((text) => text.replace('<td width="40%">SAMPLE GPO<br>Received from SAMPLE OFFICE</td>', '<td width="40%">SAMPLE (Office)</td>')))
      .toMatchObject({ location: 'SAMPLE (Office)', local_time: '2026-04-07T15:00:00' });
    // A name the map does not know falls to the shared rules, or keeps no stage.
    const unknown = parsePostaKenyaResult(edited('inbound', (text) => text.replace('<td width="45%" colspan="2">Received the item</td>\n\t\t<td width="40%">SAMPLE GPO',
      '<td width="45%" colspan="2">Sample event<br/>Note: SAMPLE PERSON</td>\n\t\t<td width="40%">SAMPLE GPO')), INBOUND);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample event' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(JSON.stringify(unknown)).not.toContain('SAMPLE PERSON');
    const held = parsePostaKenyaResult(edited('inbound', (text) => text.replace('<td width="45%" colspan="2">Received the item</td>\n\t\t<td width="40%">SAMPLE GPO',
      '<td width="45%" colspan="2">Item held<br/>Retention reason: SAMPLE REASON</td>\n\t\t<td width="40%">SAMPLE GPO')), INBOUND);
    expect(held.events![0]).toMatchObject({ description: 'Item held: SAMPLE REASON' });
    // A Kenyan scan as the newest dates the result.
    const kenyan = parsePostaKenyaResult(edited('inbound', (text) => text.replace('SAMPLE GPO<br>Received from SAMPLE OFFICE', 'SAMPLE GPO (Kenya)')), INBOUND);
    expect(kenyan).toMatchObject({ last_update: '2026-04-07T15:00:00+03:00' });
    expect(kenyan).not.toHaveProperty('last_update_local');
    // A destination the page does not name leaves none.
    expect(parsePostaKenyaResult(edited('inbound', (text) => text.replace('>(Kenya)</td>', '></td>')), INBOUND))
      .not.toHaveProperty('destination_country');
    // An item whose page lists no scan has no history yet.
    expect(() => parsePostaKenyaResult(edited('inbound', (text) => text.replace(/\t<tr style="(?:height|font-size)[^"]*">[\s\S]*?<\/tr>\n/g, '')), INBOUND))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker’s notice for a code it has no information for as missing, after two requests', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(() => parsePostaKenyaAnswer(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parsePostaKenyaAnswer(page('answer'), DELIVERED)).toBe(RESULT);
  });

  it('never reads a block page, an error page or another page as a missing item', async () => {
    const outcomes: [Partial<Record<'form' | 'lookup' | 'result', Step>>, string, number][] = [
      [{ form: () => html(CHECK) }, 'challenge', 1],
      [{ lookup: () => html(CHECK) }, 'challenge', 2],
      [{ result: () => html(CHECK) }, 'challenge', 3],
      [{ form: () => html('<html><body>Sample maintenance page</body></html>') }, 'schema', 1],
      [{ form: () => html(page('form').replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, '')) }, 'schema', 1],
      [{ form: () => html(ERROR_PAGE, 500) }, 'schema', 1],
      [{ lookup: () => html(ERROR_PAGE) }, 'schema', 2],
      [{ lookup: () => html(ERROR_PAGE, 500) }, 'schema', 2],
      [{ lookup: () => html('<html><body>Sample failure</body></html>', 500) }, 'indeterminate', 2],
      // The form again without an answer, or with another notice.
      [{ lookup: () => html(page('form')) }, 'schema', 2],
      [{ lookup: (number) => html(answer('not-found', number).replace('No information available for this shipment', 'Sample notice')) }, 'schema', 2],
      [{ lookup: (number) => html(answer('answer', number).replace('TrackResult.aspx?type=I', 'https://sample.invalid/TrackResult.aspx?type=I'), 200, opened) },
        'schema', 2],
      [{ result: () => html(ERROR_PAGE, 500) }, 'schema', 3],
      [{ result: () => html('<html><body>Sample page</body></html>') }, 'schema', 3],
      // A result page whose session holds no lookup, and an answer that opened no session, are inconclusive.
      [{ result: () => html(page('no-session')) }, 'indeterminate', 3],
      [{ lookup: (number) => html(answer('answer', number)) }, 'indeterminate', 2],
      [{ lookup: (number) => html(answer('answer', number), 200, ['ASP.NET_SessionId=; path=/']) }, 'indeterminate', 2],
    ];
    for (const [steps, kind, requests] of outcomes) {
      const fetcher = site(steps);
      await expect(carrier(fetcher).track({ number: DELIVERED }), `${kind} ${Object.keys(steps)[0]}`).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(requests);
    }
    await expect(carrier(site({ result: () => html(page('no-session')) })).track({ number: DELIVERED }))
      .rejects.toMatchObject({ reason: 'session_lost' });
  });

  it('rejects answers and result pages for another item, and changed pages', () => {
    expect(() => parsePostaKenyaAnswer(answer('answer', 'EE000000014SN'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostaKenyaAnswer(answer('not-found', DELIVERED), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => postaKenyaFormFields(page('form').replace('name="ImgBtnTrack"', 'name="Sample"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker stores some codes in lower case, which still name the item.
    expect(parsePostaKenyaResult(page('delivered'), DELIVERED).status).toBe('delivered');
    const changed = [
      edited('delivered', (text) => text.replace('>ee000000014ke<', '>EE000000014SN<')),
      edited('delivered', (text) => text.replace('>ee000000014ke<', '><')),
      edited('delivered', (text) => text.replace('<td width="15%">Origin</td>', '<td width="15%">Shipment ID</td>')),
      edited('delivered', (text) => text.replace('Item Events', 'Sample Section')),
      edited('delivered', (text) => text.replace('Item Details', 'Sample Section')),
      edited('delivered', (text) => text.replace('<div id="myDiv">', '<div id="myDiv">\n<table><tr><td>Sample</td></tr></table>')),
      // A weekday that does not fit its date, or a date that does not exist.
      edited('delivered', (text) => text.replace('Monday, March 2, 2026', 'Tuesday, March 2, 2026')),
      edited('delivered', (text) => text.replace('Monday, March 2, 2026', 'Monday, February 30, 2026')),
      edited('delivered', (text) => text.replace('Monday, March 2, 2026', '02/03/2026')),
      edited('delivered', (text) => text.replace('>10:54<', '>24:00<')),
      edited('delivered', (text) => text.replace('>10:54<', '>10.54<')),
      edited('delivered', (text) => text.replace('>10:54<', '><')),
      edited('delivered', (text) => text.replace('<td width="45%" colspan="2">Dispatched</td>', '<td width="45%" colspan="2"></td>')),
      // A scan before any day's heading.
      edited('delivered', (text) => text.replace(/(Item Events[\s\S]*?<td width="100%" colspan="4"><\/td>\n\t<\/tr>\n)/,
        '$1\t<tr><td colspan="2">Dispatched</td><td>SAMPLE OFFICE</td><td>10:00</td></tr>\n')),
    ];
    for (const html of changed) expect(() => parsePostaKenyaResult(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const rows = '<tr><td colspan="2">Dispatched</td><td>SAMPLE OFFICE</td><td>10:00</td></tr>'.repeat(1_001);
    expect(() => parsePostaKenyaResult(page('delivered').replace('<div id="myDiv">\n', `<div id="myDiv">\n<table>${rows}</table>`).replace(/<table width="100%" style="font-family:Trebuchet MS;">[\s\S]*<\/table>/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'EE000000004KE', 'EE00000005KE', 'EE000000005KEX', 'E0000000005KE', '0000000000000', 'SAMPLETRACKING',
      `EE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePostaKenyaNumber(' ee-000-000-014 ke ')).toBe(DELIVERED);
    expect(() => parsePostaKenyaResult(page('delivered'), 'EE000000004KE')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // A lookup tells known from unknown, but it is slower than recognition's budget.
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = site({ lookup: () => new Response('Too many requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }) });
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s at every step, without a retry or the session in the error', async (status, kind) => {
      for (const step of ['form', 'lookup', 'result'] as const) {
        const fetcher = site({ [step]: () => html('<html><body>Unavailable</body></html>', status) });
        const error = await carrier(fetcher).track({ number: DELIVERED }).catch((caught: unknown) => caught);
        expect(error, step).toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes({ form: 1, lookup: 2, result: 3 }[step]);
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/syntheticSession|wEPDwU/);
        expect([(error as Details).request, (error as Details).diagnostics], step).toEqual([undefined, undefined]);
      }
    });

  it('tries once more in a new session after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site({ result: () => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(page('delivered'));
    } });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `GET ${POSTA_KENYA_TRACK}`, `POST ${POSTA_KENYA_TRACK}`, `GET ${RESULT}`, `GET ${POSTA_KENYA_TRACK}`, `POST ${POSTA_KENYA_TRACK}`, `GET ${RESULT}`]);
    expect(new Headers(flaky.mock.calls[4]![1]!.headers).has('cookie')).toBe(false);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await carrier(down).track({ number: DELIVERED }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as Details).request).toBeUndefined();
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = site({ result: () => new Response(new Uint8Array(600_000)) });
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Posta Kenya to the adapter', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'posta-kenya' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posta-kenya', source: 'posta-kenya', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.slice(0, 3).map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `GET ${POSTA_KENYA_TRACK}`, `POST ${POSTA_KENYA_TRACK}`, `GET ${RESULT}`]);
    // The destination's post is asked about the item delivered there, and its answer stays apart.
    expect(fetcher.mock.calls.slice(3).every(([url]) => String(url).startsWith('https://api2.postnord.com/'))).toBe(true);
  });
});

describe('Posta Kenya status vocabulary', () => {
  it('maps every event name it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(postaKenyaWordingStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'posta-kenya', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The details after the name do not change its stage.
    expect(statusMapAnswer({ carrier: 'posta-kenya', description: 'Undelivered: SAMPLE REASON; SAMPLE MEASURE' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMap.stage('1', 'delivered')).toBeUndefined();
    expect(postaKenyaStage(' DELIVERED ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const name of ['constructor', 'toString', 'Sample event', '']) expect(postaKenyaWordingStage(name), name).toBeUndefined();
    expect(postaKenyaStage('')).toBeNull();
  });
});
