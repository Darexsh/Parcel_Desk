import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, RL_TRACING_URL, RlCarriersTracker, rlTracingUrl } from './adapter.js';
import { normalizeRlNumber, parseRlCarriers, parseRlRefusal, rlSearchErrors } from './parser.js';
import { rlScanStage, rlStage, rlSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ1234567';
const DELAYED = '900000001';
const ABSENT = 'ZZ9999999';
const REFUSED = 'ZZ0000000';
const SESSION = 'ASP.NET_SessionId=synthsession0000000000000';
const LIST = /(<input id="shipment_list" name="shipment_list" type="hidden" value=")([^"]*)(")/;
// A parsed shipment entry that tests change in place.
type Entry = ReturnType<typeof JSON.parse>;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const unescape = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** The fixture's shipment list, as JSON. */
const shipments = (name: string): Entry[] => JSON.parse(unescape(LIST.exec(fixture(name))![2]!));
/** The fixture's page holding another shipment list. */
const page = (entries: unknown, base = 'delivered') => fixture(base).replace(LIST, (_match, open: string, _value, close: string) =>
  `${open}${escape(JSON.stringify(entries))}${close}`);
/** The delivered fixture with its entry changed. */
const deliveredWith = (change: (entry: Entry) => void) => {
  const entries = shipments('delivered');
  change(entries[0]);
  return page(entries);
};
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
/** R+L's answer to a search it refuses: back to the search page, with the message in a new session. */
const refused = (cookie: string | null = `${SESSION}; domain=rlcarriers.com; path=/; secure; HttpOnly; ; SameSite=None`,
  location = '/freight/shipping/shipment-tracing') => {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', 'TS00000000=0000synthetic; Path=/; Domain=.www.rlcarriers.com');
  return new Response(`<html><head><title>Object moved</title></head><body><h2>Object moved to <a href="${location}">here</a>.</h2></body></html>`,
    { status: 302, headers });
};
const searchPage = (errors: string[]) => fixture('check-digit').replace(/Object\.freeze\(\[[^\]]*\]\)/, `Object.freeze(${JSON.stringify(errors)})`);
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

describe('R+L Carriers tracking adapter', () => {
  it('posts the tracing form once through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RlCarriersTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz1234567 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro=${DELIVERED}&docType=PRO&source=web`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`Type=PRO&TrackingNumbers=${DELIVERED}`);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'rl-carriers', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment newest first, as wall clocks, with each row once and the terminals it passed', () => {
    const result = parseRlCarriers(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-02-12T12:10:00', expected_delivery: null,
      service_name: 'Standard Service', weight_kg: 566.99,
      events: [
        { local_time: '2026-02-12T12:10:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-02-12T03:44:18', description: 'Arrived at destination terminal', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-11T22:05:36', description: 'Departed OAK HOLLOW, TN in route to destination terminal', location: 'OAK HOLLOW, TN',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-10T09:27:51', description: 'Arrived at OAK HOLLOW , TN', location: 'OAK HOLLOW, TN',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-10T01:48:13', description: 'Departed LAKEVIEW, KY in route to OAK HOLLOW , TN', location: 'LAKEVIEW, KY',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-09T18:02:40', description: 'Arrived at origin terminal', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-09T16:15:22', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The parties, the bill of lading and the pickup's town stay behind.
    const text = JSON.stringify(result);
    for (const value of ['SYNTHETIC', 'EXAMPLE AVE', '00001', 'BOL-SYNTH', 'RIVERTON']) expect(text, value).not.toContain(value);
  });

  it('reads a delayed shipment as in transit, with its estimated day and towns written without spaces', () => {
    expect(parseRlCarriers(fixture('delayed'), DELAYED)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at GAINESVILLE,GA', last_update: null, last_update_local: '2026-07-16T11:30:09',
      expected_delivery: '2026-07-17', service_name: 'Standard Service', weight_kg: 190.509,
      events: [
        { local_time: '2026-07-16T11:30:09', description: 'Arrived at GAINESVILLE,GA', location: 'GAINESVILLE, GA',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-07-15T02:05:44', description: 'Departed MESA VERDE,AZ in route to GAINESVILLE,GA', location: 'MESA VERDE, AZ',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-07-14T15:40:12', description: 'Arrived at origin terminal', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-07-14T13:12:05', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-07-14T13:12:05', description: 'Shipment Delayed', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    // The estimate is a day at midnight on the East Coast, in winter as in summer.
    const winter = page(shipments('delayed').map((entry) => ({ ...entry, Detail: { ...entry.Detail, DeliveryDate: '/Date(1770872400000)/' } })));
    expect(parseRlCarriers(winter, DELAYED).expected_delivery).toBe('2026-02-12');
    for (const value of ['/Date(1770876000000)/', '2026-02-12', '/Date(-1)/', null]) {
      const other = page(shipments('delayed').map((entry) => ({ ...entry, Detail: { ...entry.Detail, DeliveryDate: value } })));
      expect(parseRlCarriers(other, DELAYED).expected_delivery, String(value)).toBeNull();
    }
  });

  it('takes the summary’s status when it is ahead of the rows, and the summary alone without rows', () => {
    const ahead = deliveredWith((entry) => entry.History.pop());
    expect(parseRlCarriers(ahead, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: 'Arrived at destination terminal', expected_delivery: null });
    const behind = deliveredWith((entry) => { entry.Head.Status = 'In Transit'; });
    expect(parseRlCarriers(behind, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    const bare = deliveredWith((entry) => { entry.History = []; entry.Head.Status = 'In Transit'; });
    expect(parseRlCarriers(bare, DELIVERED)).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: null, expected_delivery: '2026-02-12', service_name: 'Standard Service', weight_kg: 566.99,
      summary_only: true, events: [] });
    const unknown = deliveredWith((entry) => { entry.History = null; entry.Head.Status = 'Pending Review'; });
    expect(() => parseRlCarriers(unknown, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    // A row off the usual path stands unless the summary says delivered.
    const returned = deliveredWith((entry) => {
      entry.History.pop();
      entry.History.push({ Date: '02/12/2026', Time: '09:00:00 AM', Status: 'Returned to shipper' });
    });
    expect(parseRlCarriers(returned, DELIVERED)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    const back = deliveredWith((entry) => {
      entry.Head.Status = 'In Transit';
      entry.History.pop();
      entry.History.push({ Date: '02/12/2026', Time: '09:00:00 AM', Status: 'Returned to shipper' });
    });
    expect(parseRlCarriers(back, DELIVERED)).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:returned' });
  });

  it('leaves a row it does not know without a stage, keeps no place with digits and caps the history', () => {
    const odd = deliveredWith((entry) => {
      entry.History.push({ Date: '02/13/2026', Time: '8:05:00 AM', Status: 'Freight Inspected' });
      entry.History.push({ Date: '02/13/2026', Time: '09:05:00 AM', Status: 'Arrived at DOCK 4, TN' });
    });
    expect(parseRlCarriers(odd, DELIVERED).events!.slice(0, 2)).toEqual([
      { local_time: '2026-02-13T09:05:00', description: 'Arrived at DOCK 4, TN', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-02-13T08:05:00', description: 'Freight Inspected' },
    ]);
    const many = deliveredWith((entry) => {
      entry.History = Array.from({ length: 120 }, (_, index) => ({ Date: '02/10/2026', Time: `0${1 + Math.floor(index / 60)}:${
        String(index % 60).padStart(2, '0')}:00 AM`, Status: 'Arrived at OAK HOLLOW, TN' }));
    });
    const capped = parseRlCarriers(many, DELIVERED);
    expect(capped.events).toHaveLength(100);
    expect(capped.history_truncated).toBe(true);
    expect(capped.events![0]!.local_time).toBe('2026-02-10T02:59:00');
  });

  it('reads an unknown PRO only from the notice that names it, and an answer under another PRO as that PRO', () => {
    expect(() => parseRlCarriers(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRlCarriers(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const failed = page([{ ...shipments('not-found')[0], Errors: ['The service is unavailable'] }]);
    expect(() => parseRlCarriers(failed, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const alias = deliveredWith((entry) => { entry.Head.ProNumber = 'I900000002'; entry.Detail.ProNumber = 'I900000002'; });
    expect(parseRlCarriers(alias, DELIVERED)).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: '900000002' });
    // The tracer names the PRO with its `I`, and takes it so.
    expect(parseRlCarriers(fixture('delivered'), `I${DELIVERED}`).canonical_tracking_number).toBeUndefined();
  });

  it('rejects replies it cannot read', () => {
    const broken: [string, string][] = [
      [fixture('check-digit'), 'without its shipment list'],
      [fixture('delivered').replace(LIST, '$1[{$3'), 'not JSON'],
      [page([]), 'unexpected shipment list'],
      [page([...shipments('delivered'), ...shipments('delayed')]), 'unexpected shipment list'],
      [deliveredWith((entry) => { entry.Errors = 'none'; }), 'invalid lookup errors'],
      [deliveredWith((entry) => { entry.Head = null; }), 'without its summary'],
      [deliveredWith((entry) => { entry.Head.ProNumber = DELIVERED; }), 'invalid PRO number'],
      [deliveredWith((entry) => { entry.Detail.ProNumber = 'I900000002'; }), 'details of another PRO'],
      [deliveredWith((entry) => { entry.Detail = []; }), 'invalid shipment details'],
      [deliveredWith((entry) => { entry.History = {}; }), 'invalid history'],
      [deliveredWith((entry) => { entry.History[0].Time = '13:15:22 PM'; }), 'without its status or clock'],
      [deliveredWith((entry) => { entry.History[0].Date = '02/30/2026'; }), 'without its status or clock'],
      [deliveredWith((entry) => { entry.History[0].Status = ''; }), 'without its status or clock'],
      [deliveredWith((entry) => { entry.History[0] = 'Delivered'; }), 'invalid history row'],
      [deliveredWith((entry) => { entry.Head.Status = 3; }), 'invalid Status'],
    ];
    for (const [body, message] of broken) expect(() => parseRlCarriers(body, DELIVERED), message).toThrow(message);
    for (const raw of ['', 'ZZ12345678', 'Z12345678', '12345678', 'I12345678', '1234567890', 'ZZ123456', `${'1'.repeat(70)}`]) {
      expect(() => normalizeRlNumber(raw), raw).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(['zz 123 456-7', 'IZZ1234567', '558.265.735', 'I558265735'].map(normalizeRlNumber))
      .toEqual(['ZZ1234567', 'ZZ1234567', '558265735', '558265735']);
  });

  it('reads the check digit refusal from the session the refused search opens, and no other message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(html(fixture('check-digit')));
    // R+L says the number is wrong, so a consumer can ask for it to be checked.
    await expect(carrier(fetcher).track({ number: REFUSED })).rejects.toMatchObject({ kind: 'invalid_input', reason: 'wrong_number' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(RL_TRACING_URL);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init!.body).toBeUndefined();
    // Only the session goes back, not the firewall's cookies.
    expect(new Headers(init!.headers).get('cookie')).toBe(SESSION);

    expect(rlSearchErrors(fixture('check-digit'))).toEqual([`${REFUSED}: Pro number failed check digit validation.`]);
    expect(rlSearchErrors('<html></html>')).toBeNull();
    expect(() => rlSearchErrors(searchPage([]).replace('Object.freeze([])', 'Object.freeze([1])'))).toThrow('invalid search errors');
    for (const errors of [[], [`${DELIVERED}: Pro number failed check digit validation.`], ['Trace Number is required.'],
      [`${REFUSED}: Pro number failed check digit validation.`, 'Trace Number is required.']]) {
      expect(() => parseRlRefusal(searchPage(errors), REFUSED), JSON.stringify(errors)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseRlRefusal('<html></html>', REFUSED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));

    // A redirect elsewhere, or without a session, says nothing about the number.
    for (const response of [refused(null), refused(undefined, '/freight/shipping/shipment-tracing?pro=1'), refused(undefined, 'https://example.com/freight/shipping/shipment-tracing'),
      refused('ASP.NET_SessionId=; path=/')]) {
      const once = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      await expect(carrier(once).track({ number: REFUSED })).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(once).toHaveBeenCalledTimes(1);
    }
    const looped = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused());
    await expect(carrier(looped).track({ number: REFUSED })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps failures of the session request free of the session', async () => {
    const searches: [Response | Error, string][] = [
      [html('Forbidden', 403), 'challenge'],
      [html('Busy', 429), 'rate_limited'],
      [html('Error', 500), 'indeterminate'],
      [html('Not Found', 404), 'indeterminate'],
      [html('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>'), 'challenge'],
      [new TypeError('fetch failed'), 'transport'],
    ];
    for (const [response, kind] of searches) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(refused());
      if (response instanceof Error) fetcher.mockRejectedValueOnce(response).mockResolvedValueOnce(refused()).mockRejectedValueOnce(response);
      else fetcher.mockResolvedValueOnce(response);
      const error = await carrier(fetcher).track({ number: REFUSED }, { budgetMs: 2000 }).catch((caught: unknown) => caught);
      expect(error, kind).toMatchObject({ kind });
      expect((error as { request?: unknown }).request, kind).toBeUndefined();
      expect(JSON.stringify(error), kind).not.toContain('synthsession');
    }
  });

  it('recognizes a PRO R+L knows, reads its notice and the check digit refusal as unknown, and leaves another PRO’s answer open', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture('delivered'))).mockResolvedValueOnce(html(fixture('not-found')))
      .mockResolvedValueOnce(refused()).mockResolvedValueOnce(html(fixture('check-digit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-12T12:10:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(REFUSED)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const alias = vi.fn<typeof fetch>().mockImplementation(async () => html(deliveredWith((entry) => {
      entry.Head.ProNumber = 'I900000002';
      entry.Detail.ProNumber = 'I900000002';
    })));
    await expect(carrier(alias).track({ number: DELIVERED })).resolves.toMatchObject({ canonical_tracking_number: '900000002' });
    await expect(carrier(alias).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    // The tracer's own form of that PRO, with an I in front, is the PRO itself.
    await expect(carrier(alias).recognize!('I900000002')).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-12T12:10:00' });
    expect(String(alias.mock.lastCall![0])).toBe(rlTracingUrl('900000002'));
    const none = vi.fn<typeof fetch>();
    for (const number of ['ZZ12345678', '12345678', 'ABC']) await expect(carrier(none).recognize!(number), number).resolves.toEqual({ known: false });
    await expect(carrier(none).track({ number: '12345678' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(none).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'indeterminate'], [410, 'indeterminate'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html('', status));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the rate limit’s wait, the firewall’s page, other pages and oversized replies apart from missing shipments', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(html('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    const rejected = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.'
      + '<br><br>Your support ID is: 0000000000000000000</body></html>';
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(rejected))).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><head><title>Shipment Tracing | R+L Carriers</title></head><body></body></html>']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(html(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('is asked about the dashed and I-prefixed PRO numbers detection offers it, and reads tracer links', () => {
    for (const number of ['ZZ123456-7', '90000000-1', `I${DELAYED}`, `i ${DELAYED}`]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['rl-carriers']) });
      expect(recognitionAskedCarriers(number), number).toContain('rl-carriers');
    }
    // Other references share three letters and seven digits.
    for (const number of [DELIVERED, `I${DELIVERED}`, `I${DELAYED}0`, `J${DELAYED}`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('rl-carriers');
      expect(recognitionAskedCarriers(number), number).not.toContain('rl-carriers');
    }
    expect(rlTracingUrl('zz123456-7')).toBe(`${RL_TRACING_URL}?pro=${DELIVERED}&docType=PRO&source=web`);
    expect(parseTrackingInput(rlTracingUrl(DELIVERED))).toMatchObject({ trackingNumber: DELIVERED, carrier: 'rl-carriers', source: 'link' });
  });

  it('routes a PRO the caller names R+L for to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delayed')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELAYED, carrier: 'rl-carriers' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'rl-carriers', source: 'rl-carriers', result: { current_stage: 'in_transit', expected_delivery: '2026-07-17' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === rlTracingUrl(DELAYED))).toBe(true);
  });
});

describe('R+L Carriers status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(rlStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'rl-carriers', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(rlScanStage('Departed KANSAS CITY, KS in route to destination terminal')).toBe('in_transit');
    expect(rlScanStage('Picked Up')).toBe('accepted');
    expect(rlScanStage('Delivered to a neighbour')).toBeUndefined();
    expect(['Delivered', 'In Transit', 'Delayed', 'Pending'].map(rlSummaryStage)).toEqual(['delivered', 'in_transit', 'in_transit', undefined]);
    expect(statusMapAnswer({ carrier: 'rl-carriers', providerCode: 'X', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
