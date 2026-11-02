import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CyprusPostTracker } from './adapter.js';
import { CYPRUS_POST_LOOKUP, CYPRUS_POST_ORIGIN, CYPRUS_POST_RESULTS, parseCyprusPost, parseCyprusPostForm } from './parser.js';
import { cyprusPostScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KNOWN = 'ZZ000000014CY';
const OTHER = 'ZZ000000028CY';
const INBOUND = 'ZZ000000014US';
const ABSENT = 'ZZ900000005CY';
const TOKEN = 'SyntheticFormToken0000000000000000000000';
const SIGNATURE = 'a'.repeat(64);
const FIRST_SESSION = 'cypruspost_session=syntheticSessionOne';
const SECOND_SESSION = 'cypruspost_session=syntheticSessionTwo';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200, cookies: string[] = []) => new Response(body, { status,
  headers: [['content-type', 'text/html; charset=UTF-8'], ...cookies.map(cookie => ['set-cookie', cookie] as [string, string])] });
const signed = (number: string) => `${CYPRUS_POST_RESULTS}?code=${number}&expires=1700000300&signature=${SIGNATURE}`;
const redirect = (location: string, status = 302) => new Response('', { status,
  headers: [['location', location], ['set-cookie', `${SECOND_SESSION}; path=/; httponly`]] });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseCyprusPost>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.description, event.location, event.stage]);
const failure = (run: () => unknown) => {
  try { run(); }
  catch (error) { return error as { kind?: string; reason?: string }; }
  throw new Error('no failure');
};

type Details = { request?: unknown; diagnostics?: unknown };

interface Site {
  form?: () => Response | Promise<Response>;
  lookup?: (number: string) => Response | Promise<Response>;
  results?: (number: string) => Response | Promise<Response>;
}

/** Cyprus Post's site: its tracking page opens a session, and its form redirects to a signed results page. */
function site({ form, lookup, results }: Site = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === CYPRUS_POST_LOOKUP && init?.method === 'POST') {
      const number = new URLSearchParams(String(init.body)).get('code')!;
      return lookup ? lookup(number) : redirect(signed(number));
    }
    if (url === CYPRUS_POST_RESULTS) {
      return form ? form() : html(page('form'), 200, ['XSRF-TOKEN=syntheticXsrf; path=/', `${FIRST_SESSION}; path=/; httponly`,
        'tracking_id=synthetic; path=/']);
    }
    const number = new URL(url).searchParams.get('code')!;
    return results ? results(number) : html(number === KNOWN ? page('collected') : page('not-found').replaceAll(ABSENT, number));
  });
}

describe('Cyprus Post tracking adapter', () => {
  it('opens a session on the tracking page, posts the number with the form’s fields and reads the signed results page', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CyprusPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 cy ', { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [[formUrl, formInit], [lookupUrl, lookupInit], [resultsUrl, resultsInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect(formUrl).toBe(CYPRUS_POST_RESULTS);
    expect(formInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Accept-Language': 'en' } });
    expect(new Headers(formInit.headers).has('cookie')).toBe(false);
    expect(lookupUrl).toBe(CYPRUS_POST_LOOKUP);
    expect(lookupInit).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0',
      Cookie: FIRST_SESSION, 'Content-Type': 'application/x-www-form-urlencoded', Origin: CYPRUS_POST_ORIGIN, Referer: CYPRUS_POST_RESULTS } });
    expect(Object.fromEntries(new URLSearchParams(String(lookupInit.body)))).toEqual({ wegrdlk_SyntheticHoneypot: '',
      valid_from: expect.stringMatching(/^eyJ/), _token: TOKEN, code: KNOWN });
    expect(resultsUrl).toBe(signed(KNOWN));
    expect(resultsInit).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Cookie: SECOND_SESSION, Referer: CYPRUS_POST_RESULTS } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cyprus-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item collected at its office newest first, on Nicosia’s clock, without postcodes, districts or who signed', () => {
    const result = parseCyprusPost(page('collected'), KNOWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: '2026-10-09T09:39:00+03:00', expected_delivery: null,
      pickup_point: 'EXAMPLE B.O.7', delivered_at: '2026-10-09T09:39:00+03:00' });
    expect(result.last_update_local).toBeUndefined();
    // The repeated scan appears once; scans at the same minute keep the page's order, reversed.
    expect(rows(result)).toEqual([
      ['2026-10-09T09:39:00+03:00', 'Deliver item (Inb)', 'EXAMPLE B.O.7, Cyprus', 'delivered'],
      ['2026-10-08T11:23:00+03:00', 'Receive item at collection point for pick-up (Inb)', 'EXAMPLE B.O.7, Cyprus', 'ready_for_pickup'],
      ['2026-10-06T11:57:00+03:00', 'Send items to delivery point/ collection point', 'EXAMPLE D.P.O., Cyprus', 'in_transit'],
      ['2026-10-06T11:57:00+03:00', 'Item not delivered/ Pending delivery', 'EXAMPLE D.P.O., Cyprus', 'failed_attempt'],
      ['2026-10-06T11:44:00+03:00', 'Handover item to delivery agent (Inb)', 'EXAMPLE D.P.O., Cyprus', 'out_for_delivery'],
      ['2026-10-06T11:44:00+03:00', 'Receive item at location (Inb)', 'EXAMPLE D.P.O., Cyprus', 'in_transit'],
      ['2026-10-05T14:25:00+03:00', 'Send items to delivery point/ collection point', 'EXAMPLE O/E AIR, Cyprus', 'in_transit'],
      ['2026-10-05T14:23:00+03:00', 'Receive item from customer (Otb)', 'EXAMPLE O/E AIR, Cyprus', 'accepted'],
    ]);
    for (const [name, number] of [['collected', KNOWN], ['abroad', KNOWN], ['inbound', INBOUND]] as const) {
      expect(JSON.stringify(parseCyprusPost(page(name), number)), name)
        .not.toMatch(/SIGNER|DISTRICT|AVENUE|Scheduled|Reason|Measure|\b99\d{2,4}\b|ZZ1 1ZZ/);
    }
  });

  it('names the office an item waits at, and no point for an item delivered at the door', () => {
    const delivery = /\s*<tr>\s*<td>9\/10\/2026 09:39<\/td>[\s\S]*?<\/tr>/;
    const waiting = parseCyprusPost(page('collected').replace(delivery, ''), KNOWN);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'EXAMPLE B.O.7',
      last_update: '2026-10-08T11:23:00+03:00' });
    expect(waiting.delivered_at).toBeUndefined();
    const door = parseCyprusPost(page('collected').replaceAll('Receive item at collection point for pick-up (Inb)',
      'Handover item to delivery agent (Inb)'), KNOWN);
    expect(door).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-10-09T09:39:00+03:00' });
    expect(door.pickup_point).toBeUndefined();
  });

  it('reads an item sent abroad on each post’s clock, with the country’s name and facility names without digits', () => {
    const result = parseCyprusPost(page('abroad'), KNOWN);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-03-07T13:50:00+00:00', delivered_at: '2026-03-07T13:50:00+00:00' });
    expect(result.pickup_point).toBeUndefined();
    // The page cuts the United Kingdom's ISO name at 50 characters.
    expect(rows(result)).toEqual([
      ['2026-03-07T13:50:00+00:00', 'Deliver item (Inb)', 'United Kingdom', 'delivered'],
      ['2026-03-07T09:12:00+00:00', 'Handover item to delivery agent (Inb)', 'United Kingdom', 'out_for_delivery'],
      ['2026-03-07T08:12:00+00:00', 'Hold item at point of delivery (Inb)', 'United Kingdom', 'in_transit'],
      ['2026-03-06T02:50:00+00:00', 'Receive item at office of exchange (Inb)', 'EXAMPLE HWDC, United Kingdom', 'in_transit'],
      ['2026-03-03T08:10:00+02:00', 'Insert item into bag (Otb)', 'EXAMPLE O/E AIR, Cyprus', 'in_transit'],
      ['2026-03-03T07:20:00+02:00', 'Receive item at office of exchange (Otb)', 'EXAMPLE O/E AIR, Cyprus', 'in_transit'],
      ['2026-03-02T11:40:00+02:00', 'Send item to domestic location (Otb)', 'EXAMPLE B.O.2, Cyprus', 'in_transit'],
      ['2026-03-02T09:15:00+02:00', 'Receive item from customer (Otb)', 'EXAMPLE B.O.2, Cyprus', 'accepted'],
    ]);
    const dutch = parseCyprusPost(page('abroad').replaceAll('United Kingdom of Great Britain and Northern Irela', 'Netherlands (the)'), KNOWN);
    expect(dutch.events![3]).toMatchObject({ time: '2026-03-06T02:50:00+01:00', location: 'EXAMPLE HWDC, Netherlands' });
    const unknown = parseCyprusPost(page('abroad').replaceAll('United Kingdom of Great Britain and Northern Irela', 'Exampleland'), KNOWN);
    expect(unknown).toMatchObject({ last_update: null, last_update_local: '2026-03-07T13:50:00' });
    expect(unknown.delivered_at).toBeUndefined();
    expect(unknown.events![3]).toEqual({ local_time: '2026-03-06T02:50:00', description: 'Receive item at office of exchange (Inb)',
      location: 'EXAMPLE HWDC, Exampleland', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('keeps scans from a country with several clocks, and ambiguous or missing wall clocks, as local times', () => {
    const result = parseCyprusPost(page('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_update: '2025-10-31T09:27:00+02:00',
      pickup_point: 'PARCEL24 EXAMPLE DIST. POST OFF. AREA' });
    expect(rows(result).slice(-3)).toEqual([
      ['2025-10-30T12:15:00+02:00', 'Receive item at office of exchange (Inb)', 'EXAMPLE O/E AIR, Cyprus', 'in_transit'],
      ['2025-10-08T07:39:00', 'Receive item at office of exchange (Otb)', 'EXAMPLE ISC (USPS), United States', 'in_transit'],
      ['2025-10-07T13:18:00', 'Receive item from customer (Otb)', 'United States', 'accepted'],
    ]);
    expect(result.events!.slice(-2).every(event => event.time === undefined)).toBe(true);
    expect(rows(result)[1]).toEqual(['2025-10-31T09:27:00+02:00', 'Unsuccessful item delivery attempt (Inb)',
      'PARCEL24 EXAMPLE DIST. POST OFF. AREA, Cyprus', 'failed_attempt']);
    // Nicosia's clock repeats an hour when summer time ends and skips one when it starts.
    for (const [stamp, local] of [['25/10/2026 03:30', '2026-10-25T03:30:00'], ['29/03/2026 03:30', '2026-03-29T03:30:00']] as const) {
      const shifted = parseCyprusPost(page('collected').replace('9/10/2026 09:39', stamp), KNOWN);
      expect(shifted, stamp).toMatchObject({ last_update: null, last_update_local: local });
      expect(shifted.delivered_at).toBeUndefined();
    }
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseCyprusPost(page('collected').replace('>Deliver item (Inb)<', '>Item held by customs<'), KNOWN);
    expect(shared).toMatchObject({ current_stage: 'customs' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseCyprusPost(page('collected').replace('>Deliver item (Inb)<', '>Weigh item (Inb)<'), KNOWN);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Weigh item (Inb)' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-10-09T09:39:00+03:00', description: 'Weigh item (Inb)', location: 'EXAMPLE B.O.7, Cyprus' });
  });

  it('binds the page to the whole requested number and rejects pages it cannot read', () => {
    expect(failure(() => parseCyprusPost(page('collected'), OTHER))).toMatchObject({ kind: 'schema' });
    const panel = /<div class="panel panel-default">[\s\S]*<div class="space-30"><\/div>/.exec(page('collected'))![0];
    for (const html of ['', '<html><body>Under maintenance</body></html>',
      page('collected').replace(panel, panel + panel),
      page('collected').replace(`\n                        ${KNOWN}\n`, `\n                        ${KNOWN} ${OTHER}\n`),
      page('collected').replace(`id="collapse_${KNOWN}"`, `id="collapse_${OTHER}"`),
      // The Greek page: its wording and notices are not the ones the adapter reads.
      page('collected').replace('>Time<', '>Ώρα<'),
      page('collected').replace('<th class="col-xs-3">Extra Information</th>', ''),
      page('collected').replace('</table>', '</table><table><thead><tr><th>Time</th></tr></thead></table>'),
      page('collected').replace('9/10/2026 09:39', '31/02/2026 09:39'),
      page('collected').replace('9/10/2026 09:39', '9/10/2026 24:39'),
      page('collected').replace('9/10/2026 09:39', '2026-10-09 09:39'),
      page('collected').replace('>Deliver item (Inb)<', '><'),
      page('collected').replace(/(<tbody>\s*<tr>\s*)<td>[^<]*<\/td>/, '$1'),
      page('collected').replace(/(<tbody>)([\s\S]*?<\/tr>)/, (_, open: string, row: string) => open + row.repeat(501))]) {
      expect(failure(() => parseCyprusPost(html, KNOWN)), html.slice(0, 80)).toMatchObject({ kind: 'schema' });
    }
  });

  it('reads only the page’s no-information notice as a missing item', () => {
    expect(failure(() => parseCyprusPost(page('not-found'), ABSENT))).toMatchObject({ kind: 'not_found' });
    for (const [html, reason] of [[page('not-found').replace('There is no information for this item', 'Service temporarily unavailable'), undefined],
      [page('not-found').replace(/<h4 class="text-warning">[\s\S]*?<\/h4>/, ''), undefined],
      [page('collected').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'), 'no_history'],
      [page('expired'), 'link_expired']] as const) {
      expect(failure(() => parseCyprusPost(html, html.includes(ABSENT) ? ABSENT : KNOWN)), html.slice(-600))
        .toMatchObject({ kind: 'indeterminate', reason });
    }
    for (const html of ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(failure(() => parseCyprusPost(html, ABSENT))).toMatchObject({ kind: 'challenge' });
      expect(failure(() => parseCyprusPostForm(html))).toMatchObject({ kind: 'challenge' });
    }
  });

  it('posts only the tracking form’s own fields and requires its token', () => {
    expect(parseCyprusPostForm(page('form'))).toEqual({ wegrdlk_SyntheticHoneypot: '', valid_from: expect.stringMatching(/^eyJ/), _token: TOKEN });
    for (const html of ['', page('form').replace('id="track-n-trace-form"', 'id="search-form"'),
      page('form').replace(CYPRUS_POST_LOOKUP, 'https://example.com/track-and-trace/find'),
      page('form').replace('method="POST"', 'method="GET"'),
      page('form').replace(TOKEN, 'short'),
      page('form').replace(/<input[^>]*name="code"[^>]*>/, ''),
      page('form').replace('<input type="hidden" name="_token"', '<input type="hidden" name="extra-field" value="">\n$&'),
      page('form').replace('<input type="hidden" name="_token"', '<input type="hidden" name="filler" value="">\n'.repeat(12) + '$&')]) {
      expect(failure(() => parseCyprusPostForm(html)), html.slice(0, 80)).toMatchObject({ kind: 'schema' });
    }
  });

  it('takes valid S10 item codes, Cypriot or foreign, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015CY', 'ABC12', '', '123456789012']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of [ABSENT, INBOUND, 'RR000000014DE']) {
      await expect(carrier(site()).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known item and the no-information notice, from plain HTTP', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(KNOWN)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-09T06:39:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('reads a refused session, an expired results link and a lookup that goes elsewhere as inconclusive', async () => {
    for (const [lookup, reason] of [
      [() => redirect(`${CYPRUS_POST_ORIGIN}/en`), 'session_rejected'],
      [() => redirect('/'), 'session_rejected'],
      [() => html('<html><body>Page Expired</body></html>', 419), 'session_rejected'],
      [() => redirect('https://example.com/en/track-n-trace-results'), undefined],
      [() => redirect(signed(OTHER)), undefined],
      [() => redirect(signed(KNOWN).replace(SIGNATURE, 'synthetic')), undefined],
      [() => html(page('collected')), undefined],
    ] as const) {
      const fetcher = site({ lookup });
      await expect(carrier(fetcher).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const expired = site({ results: () => html(page('expired')) });
    await expect(carrier(expired).recognize!(KNOWN)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'link_expired' });
    const sessionless = site({ form: () => html(page('form'), 200, ['XSRF-TOKEN=syntheticXsrf; path=/']) });
    await expect(carrier(sessionless).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(sessionless).toHaveBeenCalledTimes(1);
    const blocked = site({ lookup: () => html('<html><head><title>Web Page Blocked</title></head><body>FortiGuard</body></html>') });
    await expect(carrier(blocked).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s at every step, without a retry or the session in the error', async (status, kind) => {
      for (const step of ['form', 'lookup', 'results'] as const) {
        const fetcher = site({ [step]: () => html('<html><body>Unavailable</body></html>', status) });
        const error = await carrier(fetcher).track({ number: KNOWN }).catch((caught: unknown) => caught);
        expect(error, step).toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes({ form: 1, lookup: 2, results: 3 }[step]);
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/syntheticSession|SyntheticFormToken|aaaaaaaa|signature/);
        expect([(error as Details).request, (error as Details).diagnostics], step).toEqual([undefined, undefined]);
      }
    });

  it('tries once more in a new session after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site({ results: async (number) => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(number === KNOWN ? page('collected') : page('not-found'));
    } });
    await expect(carrier(flaky).track({ number: KNOWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url, init]) => `${init?.method} ${String(url).split('?')[0]}`)).toEqual([
      `GET ${CYPRUS_POST_RESULTS}`, `POST ${CYPRUS_POST_LOOKUP}`, `GET ${CYPRUS_POST_RESULTS}`,
      `GET ${CYPRUS_POST_RESULTS}`, `POST ${CYPRUS_POST_LOOKUP}`, `GET ${CYPRUS_POST_RESULTS}`]);
    expect(new Headers(flaky.mock.calls[3]![1]!.headers).has('cookie')).toBe(false);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await carrier(down).track({ number: KNOWN }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as Details).request).toBeUndefined();
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: KNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: KNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: KNOWN }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('bounds the size of each reply', async () => {
    const large = site({ form: () => new Response(new Uint8Array(1_100_000)) });
    await expect(carrier(large).track({ number: KNOWN })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Cyprus Post to the adapter', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: KNOWN, carrier: 'cyprus-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cyprus-post', source: 'cyprus-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CYPRUS_POST_ORIGIN}/`))).toBe(true);
  });

  it('is asked about Cypriot S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(KNOWN)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(KNOWN)[0]).toBe('cyprus-post');
    expect(recognitionAskedCarriers('ZZ000000015CY')).not.toContain('cyprus-post');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('cyprus-post');
  });
});

describe('Cyprus Post status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(cyprusPostScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(cyprusPostScanStage('  Deliver   item  (Inb) ')).toBe('delivered');
    expect(cyprusPostScanStage('Deliver item (Domestic)')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Deliver', 'Deliver item (Abc)', 'Παράδοση αντικειμένου']) {
      expect(cyprusPostScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('EMI', 'deliver item (inb)')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cyprus-post', description: 'Receive item at collection point for pick-up (Inb)' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
