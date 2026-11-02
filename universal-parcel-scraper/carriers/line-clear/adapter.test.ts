import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LINE_CLEAR_API, LINE_CLEAR_BRANCHES, LineClearTracker } from './adapter.js';
import { normalizeLineClearNumber, parseLineClear, parseLineClearBranches } from './parser.js';
import { lineClearStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'V000000000000017';
const IN_TRANSIT = 'V000000000000024';
const UNKNOWN = 'V000000000000031';

type Row = Record<string, unknown>;
type Reply = Row[][];

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const scan = (number: string, code: string, status: string, clock: string, extra: Row = {}): Row => ({
  StatusCode: code, UndelCode: '', UndelReason: '', Status: status, WayBillNumber: number, ShortCN: '26AAAAAAA',
  LastModifiedOn: `13/09/2026 ${clock}`, LastModifiedDate: '13/09/2026', LastModifiedTime: clock, TransitLocation: 'DCTH',
  ToBranchCode: null, NextLocation: '', Description: `${status} at DCTH by LC00001 ( PENGHANTAR CONTOH ) on 13/09/2026`, ...extra,
});
const missing = (number: string) => ({ message: `The WayBillNumber '${number}' is invalid or does not exist in the system` });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
// The page's branch lookup: one entry per code asked, in order, a code it has no place for alone.
const PLACES: Record<string, string> = { DCTH: 'DCTH ( BANDAR CONTOH )', SCTH: 'SCTH ( KAMPUNG CONTOH )' };
const branchReply = (url: string) => reply(new URL(url).searchParams.get('search')!.split(',').map((code) => PLACES[code] ?? code));
// A transport answering the tracking lookup with `answer` and the branch lookup with `branches`.
const served = (answer: () => Response | Promise<Response>, branches: (url: string) => Response | Promise<Response> = branchReply) =>
  vi.fn<typeof fetch>(async (input) => (String(input).startsWith(LINE_CLEAR_BRANCHES) ? branches(String(input)) : answer()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Line Clear HTTP adapter', () => {
  it('posts the whole waybill as the tracking page does, then asks for its branches’ places, through the supplied transport', async () => {
    const fetcher = served(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LineClearTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' v000 0000 0000 0024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(LINE_CLEAR_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
      Authorization: expect.stringMatching(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ SearchType: 'WayBillNumber', WayBillNumber: [IN_TRANSIT] });
    const [branchUrl, branchInit] = fetcher.mock.calls[1]!;
    expect(String(branchUrl)).toBe(`${LINE_CLEAR_BRANCHES}?search=HBCTH01XYZ,SCTH`);
    expect(branchInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(branchInit).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'line-clear', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history on Malaysia’s clock, as the page shows it', async () => {
    const result = await new LineClearTracker({ fetcher: served(() => reply(fixture('delivered'))) }).fetch(DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-09-14T12:40:05+08:00', expected_delivery: null,
      delivered_at: '2026-09-14T12:40:05+08:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('history_truncated');
    // The hidden scan is left out and the repeated one kept once; scans sharing a second keep the reply's order.
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location, event.description])).toEqual([
      ['2026-09-14T12:40:05+08:00', 'WB021', 'delivered', 'BANDAR CONTOH', 'Delivered'],
      ['2026-09-14T09:02:31+08:00', 'WB018', 'out_for_delivery', 'BANDAR CONTOH', 'Out for Delivery'],
      ['2026-09-14T08:15:44+08:00', 'WB017', 'in_transit', 'BANDAR CONTOH', 'Parcel has Arrived'],
      ['2026-09-13T15:20:00+08:00', 'WB020', 'failed_attempt', 'BANDAR CONTOH', 'Undelivered: Receiver not at home, call'],
      ['2026-09-13T09:10:12+08:00', 'WB018', 'out_for_delivery', 'BANDAR CONTOH', 'Out for Delivery'],
      ['2026-09-13T08:05:19+08:00', 'WB017', 'in_transit', 'BANDAR CONTOH', 'Parcel has Arrived'],
      ['2026-09-12T22:17:00+08:00', 'WB044', 'in_transit', 'HBCTH01XYZ', 'Manifest Out Scan at Exchange Hub'],
      ['2026-09-12T22:17:00+08:00', 'WB033', 'in_transit', 'HBCTH01XYZ', 'Check In at Exchange Hub'],
      ['2026-09-12T22:15:17+08:00', 'WB002', 'accepted', 'HBCTH01XYZ', 'Checked In at Pickup Branch'],
      ['2026-09-12T16:49:41+08:00', 'WB051', 'in_transit', 'KAMPUNG CONTOH', 'Manifest Out Scan Completed'],
      ['2026-09-12T16:46:30+08:00', 'WB027', 'accepted', 'KAMPUNG CONTOH', 'Order Picked Up from Station/Platform/Hotspot'],
      ['2026-09-12T01:43:12+08:00', 'WB024', 'registered', 'KAMPUNG CONTOH', 'Awaiting Shipment Handover'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // The staff a description names, the short reference and phone numbers are not kept.
    expect(JSON.stringify(result)).not.toMatch(/PENGHANTAR|LC00001|26AAAAAAA|012-000/);
  });

  it('reads a waybill that has left the exchange hub', () => {
    const result = parseLineClear(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Manifest Out Scan at Exchange Hub', last_update: '2026-10-03T23:41:08+08:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.stage, event.location])).toEqual([
      ['in_transit', 'HBCTH01XYZ'], ['in_transit', 'HBCTH01XYZ'], ['in_transit', 'SCTH'], ['accepted', 'SCTH'], ['registered', 'SCTH'],
    ]);
    // A history listed oldest first is turned round.
    expect(parseLineClear(changed('in-transit', (body) => { body[0]!.reverse(); }), IN_TRANSIT)).toEqual(result);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const rows = [
      scan(IN_TRANSIT, 'WB024', 'Awaiting Shipment Handover', '12:00:00'),
      scan(IN_TRANSIT, 'WB027', 'Order Picked Up from Station/Platform/Hotspot', '13:00:00'),
      scan(IN_TRANSIT, 'WB051', 'Manifest Out Scan Completed', '13:00:00'),
    ];
    expect(parseLineClear([rows], IN_TRANSIT).events!.map((event) => event.provider_code)).toEqual(['WB051', 'WB027', 'WB024']);
  });

  it('leaves out the scans the page hides and words the rest as the page does', () => {
    const rows = [
      scan(IN_TRANSIT, 'WB055', 'Delivery Run Sheet', '18:00:00', { UndelCode: 'DD012V001', UndelReason: 'SYNTHETIC' }),
      scan(IN_TRANSIT, 'WB055', 'Delivery Run Sheet', '17:30:00', { UndelCode: 'DD012V003', UndelReason: 'SYNTHETIC REASON +60 12-000 0000' }),
      scan(IN_TRANSIT, 'WB026', 'Synthetic hidden scan', '17:00:00'),
      scan(IN_TRANSIT, 'WB013', 'Manifest Out Scan completed', '16:00:00'),
      scan(IN_TRANSIT, 'WB018', 'Out for Delivery', '15:00:00', { UndelReason: 'IGNORED' }),
      scan(IN_TRANSIT, 'WB099', 'Synthetic note', '14:00:00'),
      scan(IN_TRANSIT, 'WB098', 'Returned to shipper', '13:00:00'),
      scan(IN_TRANSIT, 'WB024', 'Awaiting Shipment Handover', '12:00:00', { TransitLocation: 'not a code' }),
    ];
    const result = parseLineClear([rows], IN_TRANSIT);
    expect(result.events!.map((event) => [event.provider_code, event.description, event.stage ?? null])).toEqual([
      ['WB055', 'Delivery Run Sheet: Synthetic reason', null],
      ['WB013', 'Transit Cage Out', 'in_transit'],
      ['WB018', 'Out for Delivery', 'out_for_delivery'],
      ['WB099', 'Synthetic note', null],
      ['WB098', 'Returned to shipper', 'returned'],
      ['WB024', 'Awaiting Shipment Handover', 'registered'],
    ]);
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Delivery Run Sheet: Synthetic reason' });
    expect(result.events![4]).toMatchObject({ stage_source: 'wording:returned' });
  });

  it('reads the tracker’s answer for a waybill it does not have as not found', async () => {
    expect(() => parseLineClear(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLineClear([[missing(UNKNOWN)]], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A search for several numbers answers each in turn.
    expect(() => parseLineClear([fixture('in-transit')[0]!, [missing(UNKNOWN)]], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parseLineClear([[missing(UNKNOWN)], fixture('in-transit')[0]!], IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    // A waybill whose every scan the page hides has no history to show.
    expect(() => parseLineClear([[scan(IN_TRANSIT, 'WB019', 'Synthetic hidden scan', '10:00:00')]], IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a list only when it names the waybill asked', () => {
    const other = { message: 'Line Clear answered for another waybill' };
    expect(() => parseLineClear(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', ...other }));
    expect(() => parseLineClear([[missing(UNKNOWN)]], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', ...other }));
    expect(() => parseLineClear(changed('delivered', (body) => { body.push(structuredClone(body[0]!)); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', ...other }));
    expect(() => parseLineClear(changed('delivered', (body) => { body[0]![3]!.WayBillNumber = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', ...other }));
    // A longer number holding the one asked is another waybill.
    expect(() => parseLineClear(changed('delivered', (body) => { for (const row of body[0]!) row.WayBillNumber = `${DELIVERED}1`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', ...other }));
    expect(parseLineClear(changed('delivered', (body) => {
      for (const row of body[0]!) row.WayBillNumber = ` ${DELIVERED.toLowerCase()} `;
    }), DELIVERED).events).toHaveLength(12);
  });

  it('rejects a changed reply', () => {
    const first = (body: Reply) => body[0]![0]!;
    const second = (body: Reply) => body[0]![1]!;
    for (const change of [
      (body: Reply) => { body[0] = 'scans' as never; },
      (body: Reply) => { body[0] = []; },
      (body: Reply) => { body[0]![0] = 'scan' as never; },
      (body: Reply) => { body[0]!.push('scan' as never); },
      (body: Reply) => { delete first(body).WayBillNumber; },
      (body: Reply) => { first(body).WayBillNumber = 17; },
      (body: Reply) => { delete second(body).WayBillNumber; },
      (body: Reply) => { body[0] = Array.from({ length: 501 }, () => first(body)); },
      (body: Reply) => { first(body).LastModifiedDate = '2026-09-14'; },
      (body: Reply) => { first(body).LastModifiedDate = '30/02/2026'; },
      (body: Reply) => { first(body).LastModifiedTime = '24:00:00'; },
      (body: Reply) => { first(body).LastModifiedTime = '12:40'; },
      (body: Reply) => { delete first(body).LastModifiedTime; },
      (body: Reply) => { first(body).Status = 7; },
      (body: Reply) => { first(body).Status = ''; },
      (body: Reply) => { first(body).StatusCode = ['WB021']; },
      (body: Reply) => { first(body).TransitLocation = 5; },
      (body: Reply) => { first(body).UndelReason = {}; },
    ]) {
      expect(() => parseLineClear(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', [], {}, null, [[]], ['scans'], { message: 'Synthetic failure' }, [[missing(UNKNOWN), missing(UNKNOWN)]]]) {
      expect(() => parseLineClear(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the branch lookup only when it answers each code asked, in order', () => {
    expect(parseLineClearBranches(['DCTH ( BANDAR CONTOH )', 'HBCTH01XYZ', 'scth(Kampung Contoh)'], ['DCTH', 'HBCTH01XYZ', 'SCTH']))
      .toEqual(new Map([['DCTH', 'BANDAR CONTOH'], ['HBCTH01XYZ', 'HBCTH01XYZ'], ['SCTH', 'Kampung Contoh']]));
    for (const [body, codes] of [
      [['DCTH ( BANDAR CONTOH )'], ['DCTH', 'SCTH']],
      [['SCTH ( KAMPUNG CONTOH )', 'DCTH ( BANDAR CONTOH )'], ['DCTH', 'SCTH']],
      [['BANDAR CONTOH'], ['DCTH']],
      [[7], ['DCTH']],
      [{ DCTH: 'BANDAR CONTOH' }, ['DCTH']],
    ] as const) {
      expect(() => parseLineClearBranches(body, codes)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown waybill, a moved route, a refused key, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(served(() => reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads an unknown waybill from HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('<html><body>Cannot POST</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.lineclearexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ message: 'Authorization failed' }, { status: 500 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ message: 'WayBillNumber must contain at least one valid value' }, { status: 500 }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html>Internal Server Error</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Line Clear</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': '30' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = served(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('fails a lookup whose branch places cannot be read, keeping why', async () => {
    const track = (branches: (url: string) => Response | Promise<Response>) =>
      carrier(served(() => reply(fixture('in-transit')), branches)).track({ number: IN_TRANSIT });
    await expect(track(() => reply({ message: 'Too Many Attempts.' }, { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(track(() => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(track(() => reply('', { status: 302, headers: { Location: 'https://www.lineclearexpress.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(track(() => reply(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(() => reply('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(() => reply(['SCTH ( KAMPUNG CONTOH )']))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps the places it has read for later lookups', async () => {
    let lookups = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith(LINE_CLEAR_BRANCHES)) return branchReply(url);
      lookups += 1;
      return reply(fixture(lookups > 2 ? 'delivered' : 'in-transit'));
    });
    const tracker = new LineClearTracker({ fetcher });
    await tracker.fetch(IN_TRANSIT);
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ location: 'KAMPUNG CONTOH' })]) });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      LINE_CLEAR_API, `${LINE_CLEAR_BRANCHES}?search=HBCTH01XYZ,SCTH`, LINE_CLEAR_API, LINE_CLEAR_API, `${LINE_CLEAR_BRANCHES}?search=DCTH`,
    ]);
  });

  it('recognizes a known waybill and the not-found answer without the branch lookup, and asks nothing for what Line Clear does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-14T04:40:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('V000*')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === LINE_CLEAR_API)).toBe(true);
  });

  it('rejects what is not a Line Clear waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'V000000', 'SAMPLETRACKING', 'V0000000000*', '%V000000000000017', `${DELIVERED},${IN_TRANSIT}`, `V${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLineClearNumber(' v000-0000 0000 0017 ')).toBe(DELIVERED);
  });

  it('asks once more when Line Clear cannot be reached, inside the caller’s budget', async () => {
    let calls = 0;
    const flaky = served(() => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply(fixture('in-transit'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new LineClearTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a waybill filed under Line Clear to the adapter', async () => {
    const fetcher = served(() => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'line-clear' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'line-clear', source: 'line-clear', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === LINE_CLEAR_API)).toBe(true);
  });
});

describe('Line Clear numbers', () => {
  it('claims no layout of its own', () => {
    for (const number of [DELIVERED, 'W0000000000017']) expect(detectCarrierMatch(number).carrier).not.toBe('line-clear');
  });
});

describe('Line Clear status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(lineClearStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'line-clear', providerCode: 'WB021', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'line-clear', providerCode: 'WB099', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(lineClearStage('wb018', 'Synthetic note')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(lineClearStage('WB099', 'Synthetic note')).toBeNull();
  });
});
