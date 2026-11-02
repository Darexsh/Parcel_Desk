import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, aitLookupUrl, AitTracker, FASTRAK } from './adapter.js';
import { normalizeAitNumber, parseAit } from './parser.js';
import { aitStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '555000111';
const IN_TRANSIT = '555000333';
const INITIATED = '555000777';
const OTHER = '555000888';
const UNKNOWN = '555000999';

type Row = Record<string, unknown>;
interface Grid { Data: Row[]; Total: number }

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseAit>) => result.events!.map((event) => [event.local_time, event.provider_code ?? null,
  event.description, event.stage ?? null]);
// The rows of the page's history grids, as data in each grid's settings.
const GRID = /"data":(\{"Data":.*?"Total":\d+\})\}\}\);\}\);<\/script>/g;
const withRows = (html: string, change: (rows: Row[], grid: Grid) => void, which = 0) => {
  let index = -1;
  return html.replace(GRID, (whole, data: string) => {
    index += 1;
    if (index !== which) return whole;
    const grid = JSON.parse(data) as Grid;
    change(grid.Data, grid);
    return whole.replace(data, () => JSON.stringify(grid));
  });
};
const row = (clock: string, code: string, description: string): Row => ({ DateAndTime: clock, StatusDateTime: clock, StatusDate: clock,
  StatusTime: clock, Code: code, Description: description, LongDescription: 'Sample explanation.', Location: null, StatusGroupCode: code });
// The label over the progress meter.
const progress = (html: string, label: string) => html.replace(/(Status-Meter-\d+\.svg"[^>]*\/>\s*<\/div>\s*<div class="col">\s*<h3>)[^<]*/, `$1${label}`);
// A page without the history grid, as FasTrak showed shipments before it had one.
const withoutHistory = (html: string) => html.replace(/<script>kendo\.syncReady\(function\(\)\{jQuery\("#EventHistoryGrid_1"\)\.kendoGrid\([\s\S]*?<\/script>/, '');

describe('AIT Worldwide Logistics HTTP adapter', () => {
  it('asks FasTrak for the whole number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AitTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 555-000 333 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FASTRAK}?trackingnumber=${IN_TRANSIT}`);
    expect(aitLookupUrl('ab12345')).toBe('https://fastrak.aitworldwide.com/?trackingnumber=AB12345');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ait-worldwide', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first as wall clocks, without the appointment, the town, the signer or the office', () => {
    const result = parseAit(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-03-12T14:40:00', expected_delivery: null,
    });
    for (const field of ['summary_only', 'history_truncated', 'delivered_at', 'receiver_name', 'sender_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-12T14:40:00', 'POD', 'DELIVERED', 'delivered'],
      // The appointment between them is an estimate, stamped with its window's start: no scan.
      ['2026-03-12T07:15:00', 'OFD', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-03-10T15:22:00', 'RECOVD', 'CHECKED INTO DELIVERY TERMINAL', 'in_transit'],
      // The repeated row is kept once.
      ['2026-03-09T08:05:31', 'DEST', 'ARRIVED AT SORTING FACILITY', 'in_transit'],
      ['2026-03-06T19:44:02', 'ARRHUB', 'ARRIVAL HUB', 'in_transit'],
      ['2026-03-05T10:12:01', 'INTRAN', 'SHIPMENT IN TRANSIT', 'in_transit'],
      ['2026-03-04T16:30:00', 'PUCOMP', 'CARGO PICKED UP', 'accepted'],
      ['2026-03-04T09:01:47', 'EMAILD', 'EMAILED INFO', null],
      ['2026-03-04T09:01:12', 'UPLOAD', 'ORDER INFO SENT TO AIT: UPLOAD', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLETON|EXAMPLE|555-010|Signed|APPOINTMENT|BETWEEN|explanation|emailed to/i);
  });

  it('reads an in-transit history, and the newest delivery appointment’s day as the estimate', () => {
    const result = parseAit(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'ARRIVED AT SORTING FACILITY', last_update: null, last_update_local: '2026-10-14T11:20:09',
      // The page only invites the recipient to book the delivery.
      expected_delivery: null,
    });
    expect(events(result)).toEqual([
      ['2026-10-14T11:20:09', 'DEST', 'ARRIVED AT SORTING FACILITY', 'in_transit'],
      // An earlier wording of the same code.
      ['2026-10-13T06:48:00', 'ARRHUB', 'ARRIVAL SCAN', 'in_transit'],
      ['2026-10-12T13:02:41', 'INTRAN', 'SHIPMENT IN TRANSIT', 'in_transit'],
      ['2026-10-09T17:00:00', 'PUCOMP', 'CARGO PICKED UP', 'accepted'],
      ['2026-10-09T08:33:20', 'EMAILD', 'EMAILED INFO', null],
      ['2026-10-09T08:32:55', 'UPLOAD', 'ORDER INFO SENT TO AIT: UPLOAD', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE FALLS|invit|schedule/i);
    const booked = parseAit(withRows(fixture('in-transit'), (rows) => {
      rows.unshift(row('2026-10-21T08:00:00', 'APPTDE', 'APPOINTMENT DELIVERY SCHEDULED ON 10/21/2026 BETWEEN 8:00 AM AND 12:00 PM'),
        row('2026-10-15T09:30:00', 'RECOVD', 'CHECKED INTO DELIVERY TERMINAL'),
        row('2026-10-19T08:00:00', 'APPTDE', 'APPOINTMENT DELIVERY SCHEDULED ON 10/19/2026 BETWEEN 8:00 AM AND 12:00 PM'));
    }), IN_TRANSIT);
    expect(booked).toMatchObject({ current_stage: 'in_transit', last_status_text: 'CHECKED INTO DELIVERY TERMINAL',
      last_update_local: '2026-10-15T09:30:00', expected_delivery: '2026-10-21' });
    expect(booked.events).toHaveLength(7);
    expect(JSON.stringify(booked)).not.toMatch(/APPOINTMENT/);
    // An appointment row without its date in the wording gives its own clock's day.
    expect(parseAit(withRows(fixture('in-transit'), (rows) => {
      rows.unshift(row('2026-10-16T13:00:00', 'APPTDE', 'APPOINTMENT DELIVERY'));
    }), IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-10-16', last_update_local: '2026-10-14T11:20:09' });
  });

  it('picks the shipment asked out of those FasTrak finds by their references, with its deliver-by day', () => {
    const result = parseAit(fixture('several'), INITIATED);
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'ORDER INFO SENT TO AIT: WEB', last_update_local: '2026-12-29T15:41:06',
      // A weekday, a month and a day: the year with that weekday nearest the newest row's.
      expected_delivery: '2027-01-08',
    });
    expect(events(result)).toEqual([['2026-12-29T15:41:06', 'WEBENT', 'ORDER INFO SENT TO AIT: WEB', 'registered']]);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${OTHER}|SAMPLE|2026-12-28`));
    expect(parseAit(fixture('several'), OTHER)).toMatchObject({ expected_delivery: '2027-01-06', last_update_local: '2026-12-28T10:02:13' });
    // A weekday no nearby year has for that day gives no estimate.
    expect(parseAit(fixture('several').replace('<h3>Friday</h3>', '<h3>Monday</h3>'), INITIATED)).toMatchObject({ expected_delivery: null });
    // Only shipments found by their references are another shipment's answer, and so is a history bound to another number.
    expect(() => parseAit(fixture('several'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FasTrak answered for another shipment' }));
    expect(() => parseAit(fixture('several').replaceAll(OTHER, INITIATED), INITIATED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FasTrak answered with several shipments for the number' }));
    expect(() => parseAit(fixture('several').replace(`TrackingNumber: '${INITIATED}'`, `TrackingNumber: '${OTHER}'`), INITIATED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FasTrak listed the history of another shipment' }));
  });

  it('takes the further of the newest staged row and the progress meter, and reads a shipment without history from the meter', () => {
    // The meter ahead of every row is the current state, without a clock.
    const delivered = parseAit(progress(fixture('in-transit'), 'Delivered'), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null });
    expect(delivered).not.toHaveProperty('last_update_local');
    // A meter behind the newest staged row does not step it back.
    expect(parseAit(progress(fixture('delivered'), 'Initiated'), DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED' });
    expect(parseAit(withRows(fixture('in-transit'), (rows) => { rows.unshift(row('2026-10-15T07:00:00', 'OFD', 'OUT FOR DELIVERY')); }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'OUT FOR DELIVERY' });
    // Without a history, the meter's label is the state.
    const summary = parseAit(withoutHistory(fixture('in-transit')), IN_TRANSIT);
    expect(summary).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: null, summary_only: true, events: [] });
    expect(parseAit(withRows(fixture('in-transit'), (rows) => { rows.length = 0; }), IN_TRANSIT)).toMatchObject({ summary_only: true });
    const other = parseAit(progress(withoutHistory(fixture('in-transit')), 'Sample Note'), IN_TRANSIT);
    expect(other).toMatchObject({ status: 'unknown', last_status_text: 'Sample Note' });
    expect(other).not.toHaveProperty('current_stage');
    expect(() => parseAit(progress(withoutHistory(fixture('in-transit')), ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A grid that holds part of a longer history says so.
    expect(parseAit(withRows(fixture('in-transit'), (_rows, grid) => { grid.Total = 40; }), IN_TRANSIT)).toMatchObject({ history_truncated: true });
  });

  it('leaves the name of whoever signed out of a row’s wording', () => {
    const result = parseAit(withRows(fixture('delivered'), (rows) => { rows[0]!.Description = 'DELIVERED - SIGNED BY PAT EXAMPLE'; }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED - SIGNED' });
    expect(JSON.stringify(result)).not.toMatch(/PAT|EXAMPLE/);
  });

  it('reads the warning for a number FasTrak does not know as not found, and one naming another number as no answer', () => {
    expect(() => parseAit(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAit(fixture('not-found').replace(`Not Found: ${UNKNOWN}`, `Not Found: 555000998, ${UNKNOWN}`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAit(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAit(fixture('not-found').replace(/Tracking Number\(s\) Not Found: \d+/, 'Sample notice'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The shipment asked is the answer, whatever else the page lists.
    expect(parseAit(fixture('in-transit').replace('<input name="AntiforgeryFieldname"',
      `<div class="alert alert-warning" role="alert" id="NotFoundWarning">Tracking Number(s) Not Found: ${UNKNOWN}</div><input name="AntiforgeryFieldname"`), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    for (const change of [
      (rows: Row[]) => { rows[0]!.DateAndTime = null; },
      (rows: Row[]) => { rows[0]!.DateAndTime = '10/14/2026 11:20 AM'; },
      (rows: Row[]) => { rows[0]!.DateAndTime = '2026-10-14T24:00:00'; },
      (rows: Row[]) => { rows[0]!.DateAndTime = '2026-02-30T06:00:00'; },
      (rows: Row[]) => { rows[0]!.DateAndTime = '2026-10-14T11:20:09Z'; },
      (rows: Row[]) => { rows[0]!.DateAndTime = '2026-10-14T11:20:09-05:00'; },
      (rows: Row[]) => { rows[0]!.Description = null; },
      (rows: Row[]) => { rows[0]!.Description = ['ARRIVED']; },
      (rows: Row[]) => { rows[0]!.Code = 7; },
      (rows: Row[]) => { rows[0] = 'row' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[1]!)); },
      (_rows: Row[], grid: Grid) => { grid.Data = {} as never; },
      (_rows: Row[], grid: Grid) => { grid.Total = '6' as never; },
    ]) {
      expect(() => parseAit(withRows(fixture('in-transit'), change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      fixture('in-transit').replace(/<span id="lblTrackNum">\d+<\/span>/, ''),
      fixture('in-transit').replace(/<span id="lblTrackNum">\d+<\/span>/, '<span id="lblTrackNum"></span>'),
      fixture('in-transit').replace('Shipment Progress', 'Shipment Status'),
      fixture('in-transit').replace(/function GetShipmentInfo_1\(\)/, 'function GetShipment_1()'),
      fixture('in-transit').replace(/"Total":6\}/, '"Total":6,}'),
      fixture('in-transit').replace(/"DateAndTime":"2026-10-14T11:20:09"/, '"DateAndTime":2026-10-14'),
      // The search form alone answers nothing.
      fixture('not-found').replace(/<div class="alert alert-warning" role="alert" id="NotFoundWarning">[\s\S]*?<\/div>/, ''),
      '<html><head><title>AIT Worldwide Logistics</title></head><body></body></html>',
    ]) {
      expect(() => parseAit(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved page, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(null, { status: 302, headers: { Location: 'https://www.aitworldwide.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><head><script src="/_Incapsula_Resource?SWJIYLWA=0000"></script></head><body></body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>FasTrak - AIT Worldwide Logistics</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Sample error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown answer, and asks nothing for a number AIT does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:40:00' });
    await expect(carrier(page('several')).recognize!(INITIATED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-12-29T15:41:06' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another shipment is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('555000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers AIT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '555000', '55500011122', 'ABCDEFGH', 'PO-5550-001-112', '555000111/2', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['555 000 111', DELIVERED], ['555-000-111', DELIVERED], ['5550001', '5550001'], ['5550001112', '5550001112'],
      ['ab12345', 'AB12345']]) {
      expect(normalizeAitNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a number the caller names AIT’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ait-worldwide' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ait-worldwide', source: 'ait-worldwide', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === aitLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('AIT Worldwide Logistics numbers', () => {
  it('leaves bill numbers to the caller’s choice, and reads FasTrak links with either spelling', () => {
    // Bare digit runs are shared with other carriers, so neither detection nor recognition offers AIT.
    for (const number of [DELIVERED, '55500011']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('ait-worldwide');
      expect(recognitionAskedCarriers(number), number).not.toContain('ait-worldwide');
    }
    for (const link of [`https://fastrak.aitworldwide.com/?trackingnumber=${DELIVERED}`, `https://fastrak.aitworldwide.com/?TrackingNumber=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'ait-worldwide', source: 'link' });
    }
  });
});

describe('AIT Worldwide Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives, and the codes it leaves out', () => {
    const gaps = new Set(statusMap.gaps.map((gap) => gap.code));
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(aitStage(code, entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      // Every code seen either has a stage or is left out on purpose.
      if (code) expect(Boolean(entry.stage) !== gaps.has(code), entry.wording).toBe(true);
      expect(entry.unmapped === true, entry.wording).toBe(!entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ait-worldwide', providerCode: 'OFD', description: 'OUT FOR DELIVERY' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'ait-worldwide', providerCode: 'EMAILD', description: 'EMAILED INFO' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'ait-worldwide', providerCode: 'SAMPLE', description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to its wording, then to the shared rules, else stays without a stage.
    expect(aitStage('SAMPLE', 'SHIPMENT IS IN TRANSIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(aitStage('SAMPLE', 'Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(aitStage('SAMPLE', 'Sample Note')).toBeNull();
  });
});
