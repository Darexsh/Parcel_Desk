import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { IndeterminateError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { normalizeCarrierResult, type CarrierResult } from '../../core/result/index.js';
import { DpdIeTracker, adapter, type DpdGroupLookup } from './adapter.js';
import { normalizeDpdIeNumber, parseDpdIe, parseDpdIeAbsence } from './parser.js';
import { DPD_IE_DRIVER_COLLECTION, DPD_IE_POINT_COLLECTION, dpdIeScanStage, isDpdIeNotice } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '999000001';
const VAN_NUMBER = '999000002';
// Synthetic: a fourteen-digit DPD parcel number that was never issued, and its label's check character.
const PARCEL = '09990000000001';
const CHECK = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(character => dpdParcelNumber(PARCEL + character))!;
const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const van = readFileSync(new URL('./fixtures/on-van.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const edit = (change: (document: ReturnType<typeof load>) => void, body = html) => { const $ = load(body); change($); return $.html(); };
const row = ([status, place, clock]: readonly [string, string, string]) => `<li><div class="col-1"><p><strong>${status}</strong></p></div>`
  + `<div class="col-2"><p>${place}</p></div><div class="col-3"><p>${clock}</p></div></li>`;
const HEADER = '<li class="header-list"><div class="col-1"><h4>Status</h4></div><div class="col-2"><h4>Location</h4></div>'
  + '<div class="col-3"><h4>Date &amp; Time</h4></div></li>';
// Rows oldest first, as the page lists them.
const history = (...rows: (readonly [string, string, string])[]) => edit($ => $('ul.history-list').html(HEADER + rows.map(row).join('')));
const ORDER = 'Order received / DPD awaiting parcel';
const DROP_OFF = 'Customer dropped parcel at Pick Up Point';
const NETWORK = 'Your parcel is travelling through the DPD network';
const VAN = 'Your parcel is on a van and due for delivery';
const RESCHEDULED = 'Delivery of your parcel has been rescheduled';
const SEARCH = `https://tracking.dpd.ie/?deviceType=5&consignmentNumber=${NUMBER}`;
const RESULT = 'https://tracking.dpd.ie/Home/SearchResult?deviceType=5';
const ABSENT = 'https://tracking.dpd.ie/Custom500.html?aspxerrorpath=/Home/SearchResult';
const COOKIES = ['ASP.NET_SessionId=syntheticsession01; path=/; HttpOnly; SameSite=Lax',
  '__cf_bm=synthetic.bot-score_1; HttpOnly; SameSite=None; Secure; Path=/; Domain=dpd.ie'];
const SESSION = 'ASP.NET_SessionId=syntheticsession01; __cf_bm=synthetic.bot-score_1';
const reply = (body = html, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, 'Content-Type': 'text/html; charset=utf-8' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response('<html><body>Object moved</body></html>', { status: 302, headers });
};
/** The tracker: the search answers with `search`, the result page with `result`, the error page with `error`. */
const tracker = (result: () => Response, search = () => redirect('/Home/SearchResult?deviceType=5', COOKIES), error = () => reply(absent)) =>
  vi.fn<typeof fetch>(async url => String(url) === RESULT ? result() : String(url) === ABSENT ? error() : search());
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('DPD Ireland direct tracking', () => {
  it('reads the history with Irish clocks at Irish depots and without the system labels', () => {
    const result = normalizeCarrierResult(parseDpdIe(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered Letterbox', last_update: '2026-03-05T10:48:00+00:00', delivered_at: '2026-03-05T10:48:00+00:00',
      expected_delivery: null });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-05T10:48:00+00:00', 'Delivered Letterbox', 'Dpd Example North', 'delivered'],
      ['2026-03-05T06:52:00+00:00', VAN, 'Dpd Example North', 'out_for_delivery'],
      ['2026-03-04T22:17:00+00:00', NETWORK, undefined, 'in_transit'],
      ['2026-03-04T11:59:00+00:00', DPD_IE_DRIVER_COLLECTION, 'Dpd Example South', 'in_transit'],
      // The shop hands the sender's parcel to DPD.
      ['2026-03-04T11:58:00+00:00', DPD_IE_POINT_COLLECTION, 'Dpd Example South', 'in_transit'],
      ['2026-03-02T16:40:00+00:00', DROP_OFF, 'Dpd Example South', 'accepted'],
      ['2026-03-02T01:05:00+00:00', ORDER, undefined, 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    // The van scan's cut window stays out.
    expect(JSON.stringify(result)).not.toMatch(/between|Head Office|"Web"|No\. of parcels/);
  });

  it('merges the parcels of a consignment, keeps foreign wall clocks and gives the van window on the scan day', () => {
    const result = normalizeCarrierResult(parseDpdIe(van, VAN_NUMBER));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: VAN,
      last_update: '2026-07-09T07:47:00+01:00', expected_delivery_from: '2026-07-09T09:47:00+01:00', expected_delivery: '2026-07-09T10:47:00+01:00' });
    expect(result.events?.map(event => [event.time ?? event.local_time, event.description, event.stage])).toEqual([
      ['2026-07-09T07:47:00+01:00', VAN, 'out_for_delivery'],
      ['2026-07-09T06:36:00+01:00', 'DPD IE UK Inbound', 'in_transit'],
      ['2026-07-08T19:21:00+01:00', NETWORK, 'in_transit'],
      ['2026-07-07T21:28:00', 'International Hub - In Transit', 'in_transit'],
      ['2026-07-07T14:52:00', DPD_IE_DRIVER_COLLECTION, 'accepted'],
      ['2026-07-06T21:00:00+01:00', ORDER, 'registered'],
    ]);
    // No offset is established for another network's scans.
    expect(result.events?.[3]).toEqual({ local_time: '2026-07-07T21:28:00', provider_time_text: '07/7/2026 at 21:28',
      description: 'International Hub - In Transit', location: 'Sampleville - Netherlands', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('gives the window only while the van scan is the newest, on its own day', () => {
    const failed = edit($ => $('ul.history-list').append(row(["We tried to deliver but you weren't home", 'Dpd Example North', '09/7/2026 at 11:02'])), van);
    expect(parseDpdIe(failed, VAN_NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', expected_delivery: null });
    expect(parseDpdIe(failed, VAN_NUMBER).expected_delivery_from).toBeUndefined();
    for (const headline of [`${VAN}. Expected delivery time 10:47 - 09:47`, `${VAN}. Expected delivery time 05:00 - 06:00`, VAN,
      `${VAN}. Expected delivery time 9:47 - 10:47`]) {
      const result = parseDpdIe(edit($ => $('.delivery-box h3').text(headline), van), VAN_NUMBER);
      expect(result, headline).toMatchObject({ status: 'out_for_delivery', expected_delivery: null });
      expect(result.expected_delivery_from).toBeUndefined();
    }
    // A van scan at another network's place has no Irish day to put the window on.
    const foreign = edit($ => $('ul.history-list li:not(.header-list)').last().find('.col-2 p').text('Sampleville - Netherlands'), van);
    expect(parseDpdIe(foreign, VAN_NUMBER).expected_delivery).toBeNull();
  });

  it('reads the consignment a parcel number finds, and a depot named with an ampersand on Irish time', () => {
    expect(parseDpdIe(html, PARCEL)).toMatchObject({ status: 'delivered', last_update: '2026-03-05T10:48:00+00:00' });
    for (const consignment of ['', `${NUMBER}00`, PARCEL, 'SAMPLE']) {
      expect(() => parseDpdIe(edit($ => $('.tracking-status-info strong').first().text(consignment)), PARCEL), consignment)
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseDpdIe(history([DPD_IE_DRIVER_COLLECTION, 'Dpd Sample & Town', '01/3/2026 at 15:00']), NUMBER).events?.[0])
      .toMatchObject({ time: '2026-03-01T15:00:00+00:00', location: 'Dpd Sample & Town' });
  });

  it('binds the reply to the whole consignment number', () => {
    expect(parseDpdIe(html, ` ${NUMBER.slice(0, 3)} ${NUMBER.slice(3)} `).status).toBe('delivered');
    for (const body of [edit($ => $('.tracking-status-info strong').first().text('999000009')), edit($ => $('.tracking-status-info p').first().remove()),
      edit($ => $('.tracking-status-info p').first().clone().appendTo('.tracking-status-info')),
      edit($ => $('.tracking-status-info strong').first().text(`${NUMBER}0`))]) {
      expect(() => parseDpdIe(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes nine- or ten-digit consignment numbers and fourteen-digit parcel numbers', () => {
    expect(normalizeDpdIeNumber(' 999 000 001 ')).toBe(NUMBER);
    expect(normalizeDpdIeNumber('9990000010')).toBe('9990000010');
    expect(normalizeDpdIeNumber(PARCEL)).toBe(PARCEL);
    expect(normalizeDpdIeNumber(`${PARCEL} ${CHECK}`)).toBe(PARCEL);
    const wrong = [...'0123456789'].find(character => character !== CHECK)!;
    for (const number of ['', '99900000', '99900000101', '999000000000', '0999000000000', PARCEL + wrong, `${PARCEL}00`, 'ABC000001', '999-00a-001']) {
      expect(() => normalizeDpdIeNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('reports a consignment absent only on the error page that says so', () => {
    expect(() => parseDpdIeAbsence(absent)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdIeAbsence(absent.replace("couldn't", 'couldn’t'))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [absent.replace('consignment number', 'page'), absent.replace('</div>', '<p>Server Error in Application</p></div>'),
      '<html><body>Runtime Error</body></html>', '']) {
      expect(() => parseDpdIeAbsence(body)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(() => parseDpdIeAbsence(challenge)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdIe(challenge, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    // The search form alone is not an answer about the consignment.
    expect(() => parseDpdIe(edit($ => $('.status-container').remove()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDpdIe(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects malformed history and bounds it', () => {
    for (const body of [history([ORDER, 'Head Office', '31/2/2026 at 9:00']), history([ORDER, 'Head Office', '2026-03-02 09:00']),
      history([ORDER, 'Head Office', '02/3/2026 at 25:00']), history(['', 'Head Office', '02/3/2026 at 9:00']),
      edit($ => $('ul.history-list li:not(.header-list)').first().find('.col-3').remove()),
      edit($ => $('.header-list .col-3 h4').text('Date')), edit($ => $('ul.history-list').clone().appendTo('.tracking-history')),
      edit($ => $('.status-container').clone().appendTo('.container')),
      history(...Array.from({ length: 501 }, (_, index) => [NETWORK, 'Head Office', `0${1 + Math.floor(index / 60) % 9}/3/2026 at 1:${String(index % 60).padStart(2, '0')}`] as const))]) {
      expect(() => parseDpdIe(body, NUMBER)).toThrowError(expect.objectContaining({ kind: expect.stringMatching(/^(?:schema|indeterminate)$/) }));
    }
    const long = history(...Array.from({ length: 150 }, (_, index) => [NETWORK, 'Head Office',
      `0${1 + Math.floor(index / 60)}/3/2026 at ${Math.floor(index / 60) + 1}:${String(index % 60).padStart(2, '0')}`] as const));
    const events = parseDpdIe(long, NUMBER).events!;
    expect(events).toHaveLength(100);
    expect(events[0]!.time).toBe('2026-03-03T03:29:00+00:00');
  });

  it('stages collections and notices by the scans before them', () => {
    // A collection from a shop the sender did not drop the parcel at may be the recipient's.
    const point = parseDpdIe(history([ORDER, 'Head Office', '01/3/2026 at 9:00'], [NETWORK, 'Head Office', '01/3/2026 at 22:00'],
      [DPD_IE_POINT_COLLECTION, 'Dpd Example South', '03/3/2026 at 12:00']), NUMBER);
    expect(point).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: NETWORK,
      last_update: '2026-03-03T12:00:00+00:00' });
    expect(point.events?.[0]).toMatchObject({ description: DPD_IE_POINT_COLLECTION, stage: 'in_transit', stage_source: 'none' });
    const rescheduled = parseDpdIe(history([ORDER, 'Head Office', '01/3/2026 at 9:00'], ['Parcel going through Customs process', 'Head Office', '02/3/2026 at 7:00'],
      [RESCHEDULED, 'Web', '03/3/2026 at 9:30']), NUMBER);
    expect(rescheduled).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Parcel going through Customs process' });
    expect(rescheduled.events?.[0]).toEqual({ time: '2026-03-03T09:30:00+00:00', description: RESCHEDULED, stage: 'customs', stage_source: 'none' });
    // A driver's collection accepts the parcel, unless DPD already had it.
    const collected = parseDpdIe(history(['Parcel data received from sender', 'Head Office', '01/3/2026 at 9:00'],
      [DPD_IE_DRIVER_COLLECTION, 'Dpd Example North', '01/3/2026 at 15:00']), NUMBER);
    expect(collected).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(parseDpdIe(history([DPD_IE_DRIVER_COLLECTION, 'Dpd Example North', '01/3/2026 at 15:00']), NUMBER).current_stage).toBe('accepted');
    // A notice alone tells nothing about the parcel.
    expect(() => parseDpdIe(history([RESCHEDULED, 'Web', '03/3/2026 at 9:30']), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps new wording unstaged and dedupes only identical scans', () => {
    const unknown = parseDpdIe(history([NETWORK, 'Head Office', '01/3/2026 at 22:00'], ['Your parcel is ready for dispatch', 'Head Office', '02/3/2026 at 9:30']), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Your parcel is ready for dispatch' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events?.[0]).toEqual({ time: '2026-03-02T09:30:00+00:00', description: 'Your parcel is ready for dispatch' });
    const twice = parseDpdIe(history([NETWORK, 'Head Office', '01/3/2026 at 22:00'], [NETWORK, 'Head Office', '01/3/2026 at 22:00'],
      [NETWORK, 'Head Office', '02/3/2026 at 22:00'], [NETWORK, 'Dpd Example North', '02/3/2026 at 22:00']), NUMBER);
    expect(twice.events).toHaveLength(3);
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      if ('stage' in entry && entry.stage) {
        expect(dpdIeScanStage(entry.wording), entry.wording).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'dpd-ie', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
      } else {
        expect(isDpdIeNotice(entry.wording) || [DPD_IE_DRIVER_COLLECTION, DPD_IE_POINT_COLLECTION].includes(entry.wording), entry.wording).toBe(true);
      }
    }
    expect(statusMapAnswer({ carrier: 'dpd-ie', description: ` ${RESCHEDULED.toUpperCase()} ` })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'dpd-ie', description: DPD_IE_POINT_COLLECTION })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'dpd-ie', providerCode: 'DEL', description: 'Delivered' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', `${VAN}, between 09:47 - 10`, 'Order completed']) expect(dpdIeScanStage(wording), wording).toBeUndefined();
  });

  it('leaves detection to the user', () => {
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('dpd-ie');
    expect(detectCarrierMatch(PARCEL).carrier).not.toBe('dpd-ie');
  });

  it('opens a session with the search and reads the result page with its cookie', async () => {
    const fetcher = tracker(() => reply());
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ` ${NUMBER} `, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SEARCH, RESULT]);
    for (const [index, [, init]] of fetcher.mock.calls.entries()) {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('cookie')).toBe(index ? SESSION : null);
    }
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads not found from the error page the result redirects to, and nothing else', async () => {
    const missing = tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'));
    await expect(new DpdIeTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('cookie')]))
      .toEqual([[SEARCH, null], [RESULT, SESSION], [ABSENT, null]]);
    const broken = tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'), undefined, () => reply('<html><body>Runtime Error</body></html>'));
    await expect(new DpdIeTracker({ fetcher: broken }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    // A result page that lost the session sends the browser home.
    for (const location of ['/', '/?deviceType=5', 'https://other.test/Custom500.html?aspxerrorpath=/Home/SearchResult']) {
      const lost = tracker(() => redirect(location));
      await expect(new DpdIeTracker({ fetcher: lost }).fetch(NUMBER), location).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('requires the search to open a session on the tracker', async () => {
    for (const search of [() => redirect('/Home/SearchResult?deviceType=5'), () => redirect('/Home/SearchResult?deviceType=5', [COOKIES[1]!]),
      () => redirect('https://other.test/Home/SearchResult?deviceType=5', COOKIES), () => redirect('/Home/SearchResult?deviceType=1', COOKIES)]) {
      await expect(new DpdIeTracker({ fetcher: tracker(() => reply(), search) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(new DpdIeTracker({ fetcher: tracker(() => reply(), () => reply('<html><form id="consignmentNumber"></form></html>')) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'schema' });
    const challenge = () => reply('<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>');
    await expect(new DpdIeTracker({ fetcher: tracker(() => reply(), challenge) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(new DpdIeTracker({ fetcher: tracker(challenge) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once with a new session and bounds bodies', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      await expect(new DpdIeTracker({ fetcher: tracker(() => reply(), () => reply(absent, status)) }).fetch(NUMBER), `search ${status}`)
        .rejects.toMatchObject({ kind });
      await expect(new DpdIeTracker({ fetcher: tracker(() => reply(html, status)) }).fetch(NUMBER), `result ${status}`).rejects.toMatchObject({ kind });
    }
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async url => {
      calls += 1;
      if (calls === 2) throw new TypeError('fetch failed');
      return String(url) === RESULT ? reply() : redirect('/Home/SearchResult?deviceType=5', COOKIES);
    });
    expect(await new DpdIeTracker({ fetcher: flaky }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([SEARCH, RESULT, SEARCH, RESULT]);
    const missing = tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'));
    await expect(new DpdIeTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledTimes(3);
    const large = tracker(() => new Response(new Uint8Array(600_000)));
    await expect(new DpdIeTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known consignment and treats only the absent answer as unknown', async () => {
    const known = tracker(() => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!('12345')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-03-05T10:48:00.000Z' });
    const unknown = tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'));
    expect(await adapter(environment(unknown)).recognize!(NUMBER)).toEqual({ known: false });
    const lost = tracker(() => redirect('/'));
    await expect(adapter(environment(lost)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = tracker(() => reply());
    await expect(new DpdIeTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new DpdIeTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new DpdIeTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('DPD Ireland parcel numbers', () => {
  const PARCEL_SEARCH = `https://tracking.dpd.ie/?deviceType=5&consignmentNumber=${PARCEL}`;
  // DPD's guest service: each milestone once, without places.
  const milestones = (stage: string, ...events: [string, string][]): CarrierResult => ({ status: stage === 'delivered' ? 'delivered' : 'in_transit',
    current_stage: stage, last_status_text: events[0]![0], last_update: events[0]![1], history_truncated: true,
    events: events.map(([description, time]) => ({ description, time, location: '' })) });
  const handed = milestones('in_transit', ['Your parcel is on its way', '2026-03-04T22:17:00+00:00'], ['Parcel handed to DPD', '2026-03-04T11:59:00+00:00']);
  const ireland = (body = html) => tracker(() => reply(body));

  it('asks DPD Ireland and the group service together, and keeps DPD Ireland\'s fuller history', async () => {
    const fetcher = ireland();
    const group = vi.fn<DpdGroupLookup>(async () => handed);
    const result = await new DpdIeTracker({ fetcher, group }).track(`${PARCEL}${CHECK}`, { budgetMs: 10_000 });
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-03-05T10:48:00+00:00' });
    expect(result.events).toHaveLength(7);
    expect(result.history_truncated).toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([PARCEL_SEARCH, RESULT]);
    expect(group).toHaveBeenCalledTimes(1);
    expect(group.mock.calls[0]![0]).toBe(PARCEL);
    expect(group.mock.calls[0]![1]).toMatchObject({ budgetMs: 10_000 });
    // A consignment number is DPD Ireland's alone.
    expect(await new DpdIeTracker({ fetcher: ireland(), group }).track(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(group).toHaveBeenCalledTimes(1);
  });

  it('keeps the group service\'s milestones when DPD Ireland\'s history is behind them or missing', async () => {
    // DPD Ireland's history ends at the hub abroad; the group service has the delivery.
    const abroad = history([ORDER, 'Head Office', '01/3/2026 at 10:00'], [DPD_IE_DRIVER_COLLECTION, 'Dpd Sample & Town', '01/3/2026 at 15:00'],
      [NETWORK, 'Head Office', '02/3/2026 at 02:00'], ['International Hub - In Transit', 'Sampleville - Belgium', '03/3/2026 at 00:50']);
    const delivered = milestones('delivered', ['Delivered', '2026-03-06T11:00:00+01:00'], ['Parcel handed to DPD', '2026-03-01T15:00:06+00:00']);
    expect(await new DpdIeTracker({ fetcher: ireland(abroad), group: async () => delivered }).track(PARCEL)).toBe(delivered);
    const absentHere = tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'));
    expect(await new DpdIeTracker({ fetcher: absentHere, group: async () => handed }).track(PARCEL)).toBe(handed);
    const outage = async () => { throw new IndeterminateError('DPD', 'Sample outage'); };
    expect(await new DpdIeTracker({ fetcher: ireland(), group: outage }).track(PARCEL)).toMatchObject({ status: 'delivered' });
  });

  it('reports not found only when neither knows the parcel', async () => {
    const absentHere = () => tracker(() => redirect('/Custom500.html?aspxerrorpath=/Home/SearchResult'));
    await expect(new DpdIeTracker({ fetcher: absentHere(), group: async () => { throw new NotFoundError('DPD'); } }).track(PARCEL))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(new DpdIeTracker({ fetcher: absentHere(), group: async () => { throw new IndeterminateError('DPD', 'Sample outage'); } }).track(PARCEL))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes a parcel number from DPD Ireland\'s tracker alone', async () => {
    const fetcher = ireland();
    expect(await adapter(environment(fetcher)).recognize!(PARCEL)).toMatchObject({ known: true });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([PARCEL_SEARCH, RESULT]);
  });
});
