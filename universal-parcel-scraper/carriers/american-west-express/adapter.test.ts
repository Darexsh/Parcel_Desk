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
import { adapter, AMERICAN_WEST_ITREK, americanWestLookupUrl, AmericanWestTracker } from './adapter.js';
import { normalizeAmericanWestNumber, parseAmericanWest } from './parser.js';
import { americanWestStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ1000001';
const IN_TRANSIT = 'ZZ1000003';
const OTHER = 'ZZ1000005';
const UNKNOWN = 'ZZ1000009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>';
const events = (result: ReturnType<typeof parseAmericanWest>) => result.events!.map((event) => [event.local_time, event.provider_code ?? null,
  event.description, event.location ?? null, event.stage ?? null]);
/** The page with one field of its row set to another value, as the reply writes it. */
const withField = (html: string, field: string, value: string) => html.replace(new RegExp(`("${field}" : )"[^"]*"`), (_match, key: string) => `${key}${JSON.stringify(value)}`);
const withFields = (html: string, fields: Record<string, string>) => Object.entries(fields).reduce((text, [field, value]) => withField(text, field, value), html);
const REPORT = /window\.JSONReport = (\{.*\});/;
const withReport = (html: string, change: (report: { TotalRowCount: number; Rows: Record<string, unknown>[] }) => unknown) =>
  html.replace(REPORT, (_match, json: string) => `window.JSONReport = ${JSON.stringify(change(JSON.parse(json)))};`);

describe('American West HTTP adapter', () => {
  it('opens the tracker’s page for the whole pro number, searched as a pro number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AmericanWestTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz-100 0003 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${AMERICAN_WEST_ITREK}?database=awest&type=submit&interface=pltx&open_interface_search=Search+Now&open_text=${IN_TRANSIT}&SearchOn=open_billno`);
    expect(AMERICAN_WEST_ITREK).toBe('https://awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(americanWestLookupUrl('zz1000001')).toContain('&open_text=ZZ1000001&SearchOn=open_billno');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'american-west-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered shipment’s milestones as days, without the references, pieces, weight or the hub’s ETA', () => {
    const result = parseAmericanWest(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered To Customer', last_update: null, last_update_local: '2026-09-25', expected_delivery: null,
    });
    for (const field of ['summary_only', 'history_truncated', 'delivered_at', 'receiver_name', 'sender_name', 'weight_kg']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-09-25', 'ata_dest', 'Delivered To Customer', 'EXAMPLETON, TX', 'delivered'],
      // On one day, the further milestone comes first; the call moves nothing.
      ['2026-09-22', 'first_contacted_date', '1st Call 2 Customer', null, null],
      ['2026-09-22', 'atadp', 'Arrived FinalMile Agent', null, 'in_transit'],
      ['2026-09-14', 'pickup_date', 'Pickup', 'SAMPLEVILLE, CA', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-BOL|00000000000011|10000001|312|2026-09-21/);
  });

  it('reads an in-transit shipment, and the estimate from the appointment, else the ETA to the customer', () => {
    const result = parseAmericanWest(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '1st Call 2 Customer', last_update: null, last_update_local: '2026-10-16', expected_delivery: '2026-10-22',
    });
    expect(events(result)).toEqual([
      ['2026-10-16', 'first_contacted_date', '1st Call 2 Customer', null, null],
      ['2026-10-15', 'atadp', 'Arrived FinalMile Agent', null, 'in_transit'],
      ['2026-10-08', 'pickup_date', 'Pickup', 'SAMPLEVILLE, CA', 'accepted'],
    ]);
    // The last town and the town it goes to are not kept before the delivery.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE CITY|SAMPLE-BOL|00000000000033|215|2026-10-16T/);
    expect(parseAmericanWest(withField(fixture('in-transit'), 'appointment_date', ' 10-21-2026 '), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-10-21' });
    // A day before the newest milestone's is stale, and the ETA to the final mile agent is the hub's.
    expect(parseAmericanWest(withField(fixture('in-transit'), 'deliver_by_date', ' 10-15-2026 '), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseAmericanWest(withField(fixture('in-transit'), 'deliver_by_date', ''), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('takes the further of the furthest milestone and the rail, which has no clock', () => {
    const picked = withFields(fixture('in-transit'), { atadp: '', first_contacted_date: '', timeline_dots: '2:[pickup, in-transit, last mile, delivered]' });
    const ahead = parseAmericanWest(picked, IN_TRANSIT);
    expect(ahead).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'in-transit', expected_delivery: '2026-10-22' });
    expect(ahead).not.toHaveProperty('last_update_local');
    expect(events(ahead)).toEqual([['2026-10-08', 'pickup_date', 'Pickup', 'SAMPLEVILLE, CA', 'accepted']]);
    expect(parseAmericanWest(withField(picked, 'timeline_dots', '1:[pickup, in-transit, last mile, delivered]'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'accepted', status: 'in_transit', last_status_text: 'Pickup', last_update_local: '2026-10-08' });
    // A delivery on the rail settles the shipment before its day is shown.
    expect(parseAmericanWest(withField(fixture('in-transit'), 'timeline_dots', '4:[pickup, in-transit, last mile, delivered]'), IN_TRANSIT))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'delivered', expected_delivery: null });
    // A rail behind the milestones does not step them back, and one with nothing reached says nothing.
    expect(parseAmericanWest(withField(fixture('delivered'), 'timeline_dots', '2:[pickup, in-transit, last mile, delivered]'), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered To Customer' });
    expect(parseAmericanWest(withField(fixture('in-transit'), 'timeline_dots', ''), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    const railOnly = withFields(picked, { pickup_date: '' });
    expect(parseAmericanWest(railOnly, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
    expect(() => parseAmericanWest(withField(railOnly, 'timeline_dots', '0:[pickup, in-transit, last mile, delivered]'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A step the map does not know keeps its wording, without a stage.
    expect(parseAmericanWest(withField(railOnly, 'timeline_dots', '1:[sample step]'), IN_TRANSIT))
      .toMatchObject({ status: 'unknown', last_status_text: 'sample step', summary_only: true });
  });

  it('keeps a town and its state and nothing else', () => {
    const at = (value: string) => parseAmericanWest(withField(fixture('delivered'), 'delivery_location', value), DELIVERED).events![0]!.location ?? null;
    expect(at('EXAMPLETON, TX')).toBe('EXAMPLETON, TX');
    expect(at('ST. SAMPLE TX')).toBe('ST. SAMPLE, TX');
    expect(at('EXAMPLETON TX 75000')).toBeNull();
    expect(at('')).toBeNull();
  });

  it('reads the notice for a number the tracker finds nothing under as inconclusive, since older shipments get it too', () => {
    expect(() => parseAmericanWest(fixture('not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    // The notice names no number; the page's search condition does.
    expect(() => parseAmericanWest(fixture('not-found'), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered for another number' }));
    expect(() => parseAmericanWest(fixture('not-found'), OTHER)).not.toThrow(expect.objectContaining({ reason: 'portal_not_found' }));
    expect(() => parseAmericanWest(fixture('not-found').replace(/<INPUT TYPE="hidden" name="sub_condition"[^>]*>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered for another number' }));
  });

  it('keeps a shipment only when the page shows exactly one, for the whole pro number asked', () => {
    expect(() => parseAmericanWest(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered for another shipment' }));
    const row = (name: string) => (JSON.parse(REPORT.exec(fixture(name))![1]!) as { Rows: Record<string, unknown>[] }).Rows[0]!;
    expect(() => parseAmericanWest(withReport(fixture('in-transit'), (report) => ({ ...report, TotalRowCount: 2, Rows: [row('in-transit'), row('delivered')] })), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered with several shipments' }));
    expect(() => parseAmericanWest(withReport(fixture('in-transit'), (report) => ({ ...report, TotalRowCount: 2 })), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered with several shipments' }));
    expect(() => parseAmericanWest(withReport(fixture('in-transit'), (report) => ({ ...report, TotalRowCount: 0, Rows: [] })), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West returned an empty report' }));
    // A longer pro number that starts with the one asked is another shipment.
    expect(() => parseAmericanWest(withField(fixture('in-transit'), 'billno', `${IN_TRANSIT}1`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'American West answered for another shipment' }));
    expect(parseAmericanWest(withField(fixture('in-transit'), 'billno', IN_TRANSIT.toLowerCase()), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    for (const [field, value] of [
      ['pickup_date', '2026-10-08'], ['pickup_date', ' 02-30-2026 '], ['atadp', '10/15/2026'], ['ata_dest', 'today'],
      ['appointment_date', '10-21'], ['timeline_dots', '3'], ['timeline_dots', '5:[pickup, in-transit, last mile, delivered]'],
      ['timeline_dots', '2:[pickup, , last mile]'], ['billno', ''],
    ]) {
      expect(() => parseAmericanWest(withField(fixture('in-transit'), field!, value!), IN_TRANSIT), `${field}=${value}`)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      withReport(fixture('in-transit'), (report) => ({ ...report, Rows: [{ ...report.Rows[0], pickup_date: 20261008 }] })),
      withReport(fixture('in-transit'), (report) => ({ ...report, Rows: [['sample']] })),
      withReport(fixture('in-transit'), (report) => ({ ...report, Rows: 'sample' })),
      withReport(fixture('in-transit'), (report) => ({ ...report, success: 0 })),
      withReport(fixture('in-transit'), (report) => ({ ...report, Rows: Array.from({ length: 51 }, () => report.Rows[0]) })),
      fixture('in-transit').replace('window.JSONReport = {', 'window.JSONReport = {,'),
      fixture('in-transit').replace('window.JSONReport = {', 'window.JSONReport = ['),
      fixture('in-transit').replace(REPORT, 'window.JSONReport = {"success" : 1'),
      fixture('not-found').replace('no records found matching your criteria', 'Sample notice for'),
      // The search form alone answers nothing.
      fixture('not-found').replace(/<table class="global_errors">.*?<\/table>/, ''),
      '<html><head><title>Sample page</title></head><body></body></html>',
    ]) {
      expect(() => parseAmericanWest(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved page, a block page, an empty page and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(null, { status: 302, headers: { Location: 'https://awest.freightgate.com/awestTrack.html' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(BLOCKED, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(' \n'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('<html><title>AWest - I-Trek!(tm) - Main Logon - NS</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (code, kind) => {
      const fetcher = answering(() => reply('<html><body>Sample error</body></html>', { status: code }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers that are not whole pro numbers, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'Z', 'ZZ', 'ZZ100000', 'ZZ10000011', 'Z1000001', 'ZZZ1000001', '100000001', 'ZZ100000A', 'ZZ1000001/2',
      `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['zz1000001', DELIVERED], ['ZZ 1000001', DELIVERED], ['zz-1000001', DELIVERED]]) {
      expect(normalizeAmericanWestNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a lookup that hangs once more, and ends inside the budget', async () => {
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

  it('routes a pro number the caller names American West’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'american-west-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'american-west-express', source: 'american-west-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === americanWestLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('American West numbers', () => {
  it('leaves pro numbers to the caller’s choice, and reads the tracker’s links', () => {
    // Two letters and seven digits are other carriers' numbers too, so neither detection nor recognition offers American West.
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('american-west-express');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('american-west-express');
    const link = `https://awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi?database=awest&type=submit&interface=pltx&open_interface_search=Search+Now&open_text=${DELIVERED}&SearchOn=open_billno`;
    expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'american-west-express', source: 'link' });
  });
});

describe('American West status vocabulary', () => {
  it('records every milestone and rail step the map knows with the stage it gives, and the milestone it leaves out', () => {
    const gaps = new Set(statusMap.gaps.flatMap((gap) => gap.code ?? []));
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(americanWestStage(code, entry.wording), entry.wording).toBe(entry.stage);
      if (code) expect(Boolean(entry.stage) !== gaps.has(code), entry.wording).toBe(true);
      expect(entry.unmapped === true, entry.wording).toBe(!entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'american-west-express', providerCode: 'ata_dest', description: 'Delivered To Customer' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'american-west-express', providerCode: 'first_contacted_date', description: '1st Call 2 Customer' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'american-west-express', providerCode: 'sample', description: 'Sample' })).toEqual({ kind: 'unknown' });
    // A rail step's wording counts only without a code.
    expect(americanWestStage('sample', 'delivered')).toBeUndefined();
  });
});
