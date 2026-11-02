import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TCAT_TRACE, TcatTracker } from './adapter.js';
import { normalizeTcatNumber, parseTcat } from './parser.js';
import { statusMap, tcatMappedStage, tcatStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000000012';
const IN_TRANSIT = '1000000000';
const UNKNOWN = '900000000099';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The scan rows the server writes on one line of the hidden status table.
const ROWS = /<tr valign='center'.*<\/tr>/;
type Scan = [label: string, clock: string, place?: string];
const cell = (text: string) => `<td class='style1' >        <span class='bl12'>${text}</span>    </td>`;
const row = ([label, clock, place = '範例營業所']: Scan) => `<tr valign='center' align='middle' bgcolor='#cef4f5'>    ${cell(label)}    `
  + `<td class='style1' >        <div align='center'>            <span class='bl12'>${clock.replace(' ', ' <br>')}</div>    </td>    ${cell(place)}    </tr>`;
const parcel = (number: string, scans: Scan[]) => row(scans[0]!).replace(/^(<tr[^>]*>)/, `$1    <td height='44' rowspan='${scans.length}'>        `
  + `<span class='bl12'>${number}</span></td>`) + scans.slice(1).map(row).join('');
/** The delivered page with its scans replaced, or its row line changed. */
const page = (change: string | ((rows: string) => string), name = 'delivered') => fixture(name).replace(ROWS, (rows) => (typeof change === 'string' ? change : change(rows)));
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('T-CAT HTTP adapter', () => {
  it('opens the tracking page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TcatTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000-000-000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TCAT_TRACE}?BillID=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 't-cat', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the scans newest first, in Taipei time, with the branch or centre in charge', () => {
    const result = parseTcat(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '順利送達', last_update: '2026-03-12T14:07:00+08:00', expected_delivery: null, delivered_at: '2026-03-12T14:07:00+08:00' });
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-12T14:07:00+08:00', '中和範例營業所', '順利送達', 'delivered'],
      ['2026-03-12T08:21:00+08:00', '中和範例營業所', '配送中', 'out_for_delivery'],
      ['2026-03-11T16:40:00+08:00', '中和範例營業所', '另約時間', 'failed_attempt'],
      ['2026-03-11T08:05:00+08:00', '中和範例營業所', '配送中', 'out_for_delivery'],
      ['2026-03-10T23:12:00+08:00', '北範例區轉運中心', '轉運中', 'in_transit'],
      // A branch written as text rather than a link.
      ['2026-03-10T17:46:00+08:00', '範例特販一所', '已集貨', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    // The tooltips and the display template's placeholder are not read.
    expect(JSON.stringify(result)).not.toMatch(/包裹已經送達收件人|900000000000|2026-01-01/);
  });

  it('reads a ten-digit waybill on its way', () => {
    expect(parseTcat(fixture('in-transit'), IN_TRANSIT)).toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: '轉運中', last_update: '2026-04-18T02:30:00+08:00', expected_delivery: null,
      events: [
        { time: '2026-04-18T02:30:00+08:00', location: '中範例區轉運中心', description: '轉運中', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-17T19:55:00+08:00', location: '西屯範例營業所', description: '已集貨', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
  });

  it('keeps a cash-on-delivery parcel heading back as returned, a delivery to the sender included', () => {
    const back = parseTcat(page(parcel(DELIVERED, [['順利送達', '2026/03/14 11:00'], ['配送中', '2026/03/14 08:00'], ['客樂得貨物退回中', '2026/03/13 11:51'],
      ['暫置營業所保管中（請聯絡黑貓宅急便）', '2026/03/13 07:50'], ['不在家', '2026/03/12 15:32'], ['已集貨', '2026/03/11 09:53']])), DELIVERED);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: '順利送達' });
    expect(back).not.toHaveProperty('delivered_at');
    expect(back.events!.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'returned', 'exception', 'failed_attempt', 'accepted']);
    const held = parseTcat(page(parcel(DELIVERED, [['調查處理中', '2026/03/14 11:00'], ['客樂得貨物退回中', '2026/03/13 11:51']])), DELIVERED);
    expect(held).toMatchObject({ current_stage: 'exception' });
  });

  it('stages a bracketed variant of a label, and leaves an unknown label without a stage', () => {
    const variant = parseTcat(page(parcel(DELIVERED, [['配送中(當配下車)', '2026/03/12 08:21'], ['已集貨', '2026/03/11 17:46']])), DELIVERED);
    expect(variant).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: '配送中(當配下車)' });
    const unknown = parseTcat(page(parcel(DELIVERED, [['範例貨態', '2026/03/12 08:21']])), DELIVERED);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: '範例貨態', last_update: '2026-03-12T08:21:00+08:00' });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('keeps a row listed twice once, and orders rows by their clocks', () => {
    const doubled = parseTcat(page((rows) => rows.replace(/(<\/tr>)(<tr)/, `$1${row(['配送中', '2026/03/12 08:21', '中和範例營業所'])}$2`)), DELIVERED);
    expect(doubled.events).toHaveLength(6);
    const shuffled = parseTcat(page(parcel(DELIVERED, [['已集貨', '2026/03/10 17:46'], ['順利送達', '2026/03/12 14:07'], ['轉運中', '2026/03/10 23:12']])), DELIVERED);
    expect(shuffled.events!.map((event) => event.description)).toEqual(['順利送達', '轉運中', '已集貨']);
    expect(shuffled).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-12T14:07:00+08:00' });
  });

  it('keeps scans of one minute in the page’s order, reversed when it lists them oldest first', () => {
    const descriptions = (scans: Scan[]) => parseTcat(page(parcel(DELIVERED, scans)), DELIVERED).events!.map((event) => event.description);
    expect(descriptions([['配送中', '2026/03/12 08:21'], ['轉運中', '2026/03/12 08:21'], ['已集貨', '2026/03/10 17:46']]))
      .toEqual(['配送中', '轉運中', '已集貨']);
    expect(descriptions([['已集貨', '2026/03/10 17:46'], ['轉運中', '2026/03/12 08:21'], ['配送中', '2026/03/12 08:21']]))
      .toEqual(['配送中', '轉運中', '已集貨']);
  });

  it('caps a long history at its newest scans', () => {
    const scans = Array.from({ length: 120 }, (_, index): Scan => ['轉運中', `2026/03/${String(1 + Math.floor(index / 24)).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00`]);
    const result = parseTcat(page(parcel(DELIVERED, scans)), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-03-05T23:00:00+08:00' });
  });

  it('counts a page only when it names the number asked', () => {
    expect(() => parseTcat(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'T-CAT answered for another shipment' }));
    expect(() => parseTcat(page((rows) => rows + parcel('900000000020', [['轉運中', '2026/03/12 08:21']])), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTcat(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'T-CAT answered for another number' }));
  });

  it('reads the page’s notice for a number without a status as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const both = fixture('not-found').replace(/(<td>負責營業所 <\/td>\s*<\/tr>)/, `$1${parcel(UNKNOWN, [['轉運中', '2026/03/12 08:21']])}`);
    expect(() => parseTcat(both, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      fixture('delivered').replace('id="resultTable"', 'id="statusTable"'),
      page(''),
      page((rows) => rows.replace("<td height='44' rowspan='6'>        <span class='bl12'>900000000012</span></td>", '')),
      page((rows) => rows.replace('<span class=\'bl12\'>900000000012</span>', '')),
      page((rows) => rows + parcel(DELIVERED, [['轉運中', '2026/03/12 08:21']])),
      page((rows) => rows.replace(/(<\/tr>)$/, '<td>範例</td>$1')),
      page(parcel(DELIVERED, [['', '2026/03/12 08:21']])),
      page(parcel(DELIVERED, [['轉運中', '2026-03-12 08:21']])),
      page(parcel(DELIVERED, [['轉運中', '2026/03/12']])),
      page(parcel(DELIVERED, [['轉運中', '2026/02/30 08:21']])),
      page(parcel(DELIVERED, [['轉運中', '2026/03/12 24:00']])),
      page(parcel(DELIVERED, Array.from({ length: 501 }, (): Scan => ['轉運中', '2026/03/12 08:21']))),
      '',
      '<html><head><title>黑貓宅急便</title></head><body>系統維護中</body></html>',
    ]) {
      expect(() => parseTcat(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from missing parcels', async () => {
    const lookup = (body: string, status = 200, headers: Record<string, string> = {}) =>
      carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, headers))).track({ number: UNKNOWN });
    await expect(lookup('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>驗證</title></head><body><div class="g-recaptcha"></div><script src="https://www.google.com/recaptcha/api.js"></script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', 403))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup('', 302, { Location: '/error.aspx' })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>黑貓宅急便</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('<html><title>Error</title></html>', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number, and asks nothing for one T-CAT does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!('90000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers T-CAT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000000', '10000000001', '9000000000123', 'TC00000000', '90000000001A', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTcatNumber(' 9000-0000-0012 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
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

  it('routes a number filed under T-CAT to the adapter, and leaves its plain digit run unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 't-cat' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 't-cat', source: 't-cat', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(TCAT_TRACE))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('t-cat');
    expect(detectCarrierMatch(IN_TRANSIT).carrier).not.toBe('t-cat');
  });
});

describe('T-CAT status vocabulary', () => {
  it('maps every recorded wording to the stage it records', () => {
    const entries = statuses.entries as { wording: string; stage: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(4);
    for (const entry of entries) {
      expect(tcatStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(tcatMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 't-cat', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 't-cat', description: '範例貨態' })).toEqual({ kind: 'unknown' });
  });
});
