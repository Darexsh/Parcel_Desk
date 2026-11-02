import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TIRUPATI_DETAIL, TIRUPATI_HEADER, TirupatiTracker } from './adapter.js';
import { normalizeTirupatiNumber, parseTirupati, TIRUPATI_ORIGIN, tirupatiDetailUrl, tirupatiLookupFields } from './parser.js';
import { statusMap, tirupatiMappedStage, tirupatiStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000000011';
const IN_TRANSIT = '900000000022';
const UNKNOWN = '900000000033';
// The server's key for the number, written raw in the lookup's redirect.
const ENCRYPTED = 'AAAAAAAAAAAAAAAA+BBBBBBBBBBBBBBBB/CCCCCCCCC=';
const LIST = `/Frm_DocList.aspx?docnos=${ENCRYPTED}`;
const DETAIL = `${TIRUPATI_DETAIL}?docno=AAAAAAAAAAAAAAAA%2BBBBBBBBBBBBBBBBB%2FCCCCCCCCC%3D`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The jobs table's contents.
const TRACK = /(<table id="tblTrack">)[\s\S]*?(<\/table>)/;
type Job = [job: string, day: string, route: string];
const HEAD = '<tr style="background-color:#5B0000;font-weight:bold;color:#FFFFFF;"><td width="60px">JOB</td><td width="100px">DATE</td>'
  + '<td width="490px">TRANSIT ROUTE</td></tr>';
/** The in-transit page with its jobs, and optionally its status line, replaced. */
const page = (jobs: Job[], status?: string) => {
  const html = fixture('in-transit').replace(TRACK, (_, open: string, close: string) => open + (jobs.length ? HEAD : '')
    + jobs.map(([job, day, route]) => `<tr><td>${job}</td><td>${day}</td><td>${route}</td></tr>`).join('') + close);
  return status === undefined ? html : html.replace(/(<span id="lblStatus"[^>]*>)[\s\S]*?(<\/span>)/, `$1${status}$2`);
};
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const moved = (location: string) => () => reply('<html><head><title>Object moved</title></head></html>', 302, { Location: location });
type Reply = string | (() => Response | Promise<Response>);
/** The site's three pages: the header's tracking box, its post back and the tracking detail. */
const site = (detail: Reply, { header = fixture('header'), lookup = moved(LIST) }: { header?: Reply; lookup?: Reply } = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const page = String(url) === TIRUPATI_HEADER ? (init?.method === 'POST' ? lookup : header) : detail;
    return typeof page === 'string' ? reply(page) : page();
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Shree Tirupati Courier HTTP adapter', () => {
  it('posts the number through the header’s tracking box and opens the detail its answer points to, through the supplied transport', async () => {
    const fetcher = site(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TirupatiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' };
    expect(fetcher.mock.calls[0]).toEqual([TIRUPATI_HEADER, expect.objectContaining({ method: 'GET', redirect: 'manual', headers,
      signal: expect.any(AbortSignal) })]);
    expect(fetcher.mock.calls[1]).toEqual([TIRUPATI_HEADER, expect.objectContaining({ method: 'POST', redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } })]);
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)))).toEqual({
      __VIEWSTATE: 'U3ludGhldGljIHZpZXcgc3RhdGUgKyBzbGFzaC8=', __VIEWSTATEGENERATOR: '0A1B2C3D',
      __EVENTVALIDATION: 'U3ludGhldGljIGV2ZW50IHZhbGlkYXRpb24=', trackingno: IN_TRANSIT, btnTrack: 'Go', networksearch: '',
    });
    // The key's + and / are encoded, so the server reads them back unchanged.
    expect(fetcher.mock.calls[2]).toEqual([DETAIL, expect.objectContaining({ method: 'GET', redirect: 'manual', headers })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tirupati-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered consignment: its booking in Indian time, and its delivery’s day and office', () => {
    const result = parseTirupati(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered On Dated 12-09-26 By SAMPLEPUR', last_update: null, last_update_local: '2026-09-12',
      expected_delivery: null, timezone: 'Asia/Kolkata', history_truncated: true, events: [
        { local_time: '2026-09-12', location: 'SAMPLEPUR', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-09-11T09:19:00Z', location: 'SAMPLE NAGAR (12)', description: 'Booked', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    // The consignee, the destination and the offices' phone numbers are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE TRADERS|SAMPLEPUR - MAIN|Contact|9000000/);
  });

  it('reads a consignment on its way: the jobs newest first, each on its day, at the office it names first', () => {
    const result = parseTirupati(fixture('in-transit'), IN_TRANSIT);
    const job = (local_time: string, location: string, description: string, provider_code: string) => (
      { local_time, location, description, provider_code, stage: 'in_transit', stage_source: 'carrier_map' });
    // The status line repeats the newest job, which is kept once.
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Received At SAMPLEPUR-MAIN (19) On Dated 03-08-26', last_update: null, last_update_local: '2026-08-03',
      expected_delivery: null, timezone: 'Asia/Kolkata', events: [
        job('2026-08-03', 'SAMPLEPUR-MAIN (19)', 'Received At SAMPLEPUR-MAIN (19)', 'IN'),
        job('2026-08-03', 'SAMPLE R.O.', 'Out To SAMPLEPUR-MAIN (19)', 'OUT'),
        job('2026-08-03', 'SAMPLE R.O.', 'Received At SAMPLE R.O.', 'IN'),
        job('2026-08-03', 'SAMPLE R.O.-AIR PORT', 'Out To SAMPLE R.O.', 'OUT'),
        job('2026-08-02', 'SAMPLE NAGAR (WB)', 'Out To SAMPLE R.O.-AIR PORT', 'OUT'),
        { time: '2026-08-02T11:32:00Z', location: 'SAMPLE NAGAR (WB)', description: 'Booked', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    // The offices' tooltips hold their addresses and phone numbers; the consignee is not kept either.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE|SERVICE|Ph:|9000000|OTC/);
  });

  it('reads jobs in bold, a status line newer than the jobs, and a job not seen yet by its code alone', () => {
    const bold = parseTirupati(page([['OUT', '29-08-26', 'From: <b>SAMPLE RO-EAST</b> To: <b>SAMPLE R.O.-NORTH</b>']],
      'Out To SAMPLE R.O.-NORTH On Dated 29-08-26<br/>For Any Query, Contact To -- 9000000301 -- 9000000302'), IN_TRANSIT);
    expect(bold.events!.slice(0, -1)).toEqual([{ local_time: '2026-08-29', location: 'SAMPLE RO-EAST', description: 'Out To SAMPLE R.O.-NORTH',
      provider_code: 'OUT', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(bold.last_status_text).toBe('Out To SAMPLE R.O.-NORTH On Dated 29-08-26');
    const later = parseTirupati(page([['IN', '03-08-26', 'At: SAMPLE R.O. 9000000303 From: SAMPLE HUB']],
      'Out To SAMPLE HUB On Dated 04-08-26'), IN_TRANSIT);
    expect(later.events!.slice(0, 2)).toEqual([
      { local_time: '2026-08-04', description: 'Out To SAMPLE HUB', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-08-03', location: 'SAMPLE R.O.', description: 'Received At SAMPLE R.O.', provider_code: 'IN',
        stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    const other = parseTirupati(page([['RTB', '05-08-26', 'From: SAMPLE R.O. To: ASHA EXAMPLE']], ''), IN_TRANSIT);
    expect(other.events![0]).toMatchObject({ local_time: '2026-08-05', description: 'RTB', provider_code: 'RTB' });
    expect(other.events![0]).not.toHaveProperty('location');
    expect(JSON.stringify(other.events)).not.toContain('ASHA');
  });

  it('keeps a job listed twice once, orders jobs by their days and caps a long history', () => {
    const route = 'From: SAMPLE R.O. To: SAMPLE HUB';
    const doubled = parseTirupati(page([['OUT', '03-08-26', route], ['OUT', '03-08-26', route]], ''), IN_TRANSIT);
    expect(doubled.events).toHaveLength(2);
    const shuffled = parseTirupati(page([['IN', '05-08-26', 'At: SAMPLE HUB'], ['OUT', '03-08-26', route],
      ['OUT', '05-08-26', 'From: SAMPLE HUB To: SAMPLEPUR']], ''), IN_TRANSIT);
    expect(shuffled.events!.map((event) => event.description)).toEqual(['Out To SAMPLEPUR', 'Received At SAMPLE HUB', 'Out To SAMPLE HUB', 'Booked']);
    const jobs = Array.from({ length: 120 }, (_, index): Job => ['OUT', `${String(1 + (index % 28)).padStart(2, '0')}-0${1 + Math.floor(index / 28)}-26`,
      `From: SAMPLE R.O. To: SAMPLE HUB ${index}`]);
    const long = parseTirupati(page(jobs, ''), IN_TRANSIT);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ history_truncated: true, last_update_local: '2026-05-08' });
  });

  it('reads a status line without jobs or booking as a summary, and a booking alone as its first scan', () => {
    const empty = fixture('not-found');
    const line = parseTirupati(empty.replace(/(<span id="lblStatus"[^>]*>)/, '$1Delivered On Dated 12-09-26 By SAMPLEPUR'), UNKNOWN);
    expect(line).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-09-12' });
    const unread = parseTirupati(empty.replace(/(<span id="lblStatus"[^>]*>)/, '$1SAMPLE NOTICE'), UNKNOWN);
    expect(unread).toEqual({ status: 'unknown', last_status_text: 'SAMPLE NOTICE', last_update: null, expected_delivery: null,
      timezone: 'Asia/Kolkata', summary_only: true, events: [] });
    const booked = parseTirupati(empty.replace(/(<span id="txtDate">)/, '$102-08-26 - 12:05 AM'), UNKNOWN);
    expect(booked).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: '2026-08-01T18:35:00Z',
      events: [{ time: '2026-08-01T18:35:00Z', description: 'Booked' }] });
    expect(() => parseTirupati(empty.replace(/(<span id="txtToCenter"[^>]*>)/, '$1SAMPLEPUR'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a page only when it names the number asked', () => {
    expect(() => parseTirupati(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Tirupati Courier answered for another shipment' }));
    expect(() => parseTirupati(fixture('delivered').replace(`value="${DELIVERED}"`, `value="${UNKNOWN}"`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the page for a number without a booking as not found', async () => {
    await expect(carrier(site(fixture('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('rejects a changed tracking detail', () => {
    const delivered = fixture('delivered');
    for (const html of [
      delivered.replace('id="lblDocNumber"', 'id="lblNumber"'),
      delivered.replace('id="lblStatus"', 'id="lblState"'),
      delivered.replace('id="tblTrack"', 'id="tblTracking"'),
      delivered.replace('id="txtReceiver"', 'id="txtConsignee"'),
      delivered.replace('11-09-26 - 02:49 PM', '31-02-26 - 02:49 PM'),
      delivered.replace('11-09-26 - 02:49 PM', '11-09-2026 14:49'),
      delivered.replace('On Dated 12-09-26', 'On Dated 12-13-26'),
      '',
      '<html><head><title>Shree Tirupati Courier Service</title></head><body>Site under maintenance</body></html>',
    ]) {
      expect(() => parseTirupati(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      page([['OUT', '03-08-26', 'SAMPLE R.O. - SAMPLE HUB']]),
      page([['IN', '03-08-26', 'Received']]),
      page([['OUT', '2026-08-03', 'From: SAMPLE R.O. To: SAMPLE HUB']]),
      page([['', '03-08-26', 'From: SAMPLE R.O. To: SAMPLE HUB']]),
      page([['OUT', '03-08-26', 'From: SAMPLE R.O. To: SAMPLE HUB']]).replace('<td>03-08-26</td>', ''),
      page(Array.from({ length: 301 }, (): Job => ['OUT', '03-08-26', 'From: SAMPLE R.O. To: SAMPLE HUB'])),
    ]) {
      expect(() => parseTirupati(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTirupati(CHECK, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects a changed tracking box or answer', () => {
    const header = fixture('header');
    expect(() => tirupatiLookupFields(header.replace('id="trackingno"', 'id="awb"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => tirupatiLookupFields(header.replace('id="btnTrack"', 'id="btnGo"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => tirupatiLookupFields(header.replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Shree Tirupati Courier returned a tracking box without its state' }));
    expect(() => tirupatiLookupFields(CHECK, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(tirupatiDetailUrl(LIST)).toBe(DETAIL);
    expect(tirupatiDetailUrl(`${TIRUPATI_ORIGIN}/Frm_DocList.aspx?docnos=AAAAAAAAAAAAAAAA%2BBBBBBBBBBBBBBBBB%2FCCCCCCCCC%3D`)).toBe(DETAIL);
    for (const location of ['/Frm_DocList.aspx?docnos=', '/Frm_DocList.aspx?docnos=%E0%A4%A', '/Frm_DocList.aspx?docnos=AAAA%3Cscript%3E',
      '/Frm_DocList.aspx?docno=AAAAAAAAAAAA']) {
      expect(() => tirupatiDetailUrl(location), location).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => tirupatiDetailUrl('/_NotAvailable.aspx')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const location of [null, '/', 'https://elsewhere.example/Frm_DocList.aspx?docnos=AAAAAAAA', 'http://[']) {
      expect(() => tirupatiDetailUrl(location)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
  });

  it('keeps a browser check, the error page, a moved route and a broken page apart from missing parcels', async () => {
    const lookup = (detail: Reply, pages: Parameters<typeof site>[1] = {}) => carrier(site(detail, pages)).track({ number: UNKNOWN });
    const notFound = fixture('not-found');
    await expect(lookup(notFound, { header: () => reply(CHECK, 403) })).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(notFound, { header: CHECK })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(notFound, { lookup: CHECK })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    // The box answers a post it does not take with itself.
    await expect(lookup(notFound, { lookup: fixture('header') }))
      .rejects.toMatchObject({ kind: 'schema', message: 'Shree Tirupati Courier did not take the tracking lookup' });
    // The site sends a request it fails to its maintenance page, which is no answer.
    await expect(lookup(notFound, { lookup: moved('/_NotAvailable.aspx') })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(moved(`${TIRUPATI_ORIGIN}/_NotAvailable.aspx`))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(notFound, { header: moved('/index.aspx') })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(notFound, { lookup: moved('/index.aspx') })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(moved('/index.aspx'))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Shree Tirupati Courier Service</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(new Uint8Array(600_000)))).rejects.toThrow('unexpectedly large');
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without a retry, and without the request that carries the key', async (status, kind) => {
      const fetcher = site(() => reply('<html><title>Error</title></html>', status, { 'Retry-After': '30' }));
      const error = await carrier(fetcher).track({ number: DELIVERED }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(error).not.toHaveProperty('request', expect.anything());
      expect(error).not.toHaveProperty('diagnostics', expect.anything());
      expect(JSON.stringify(error)).not.toContain('CCCCCCCCC');
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number by its booking, and asks nothing for one Shree Tirupati Courier does not issue', async () => {
    const fetcher = site(fixture('delivered'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-11T09:19:00.000Z' });
    await expect(carrier(fetcher).recognize!('90000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Shree Tirupati Courier does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000000001', '9000000000111', 'ABCDEFGHIJKL', `${DELIVERED},${IN_TRANSIT}`, '', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTirupatiNumber(' 9000-0000-0011 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(fixture('delivered'));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Shree Tirupati Courier to the adapter, and leaves its digit run unclaimed', async () => {
    const fetcher = site(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tirupati-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tirupati-courier', source: 'tirupati-courier', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${TIRUPATI_ORIGIN}/`))).toBe(true);
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('tirupati-courier');
      expect(recognitionAskedCarriers(number)).not.toContain('tirupati-courier');
    }
  });
});

describe('Shree Tirupati Courier status vocabulary', () => {
  it('maps every recorded job and wording to the stage it records', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) {
      const code = entry.code ?? null;
      expect(tirupatiStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(tirupatiMappedStage(code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'tirupati-courier', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'tirupati-courier', providerCode: null, description: 'SAMPLE NOTICE' })).toEqual({ kind: 'unknown' });
  });
});
