import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition, carrierRequirements, requirementSatisfied } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InputRequiredError, InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DX_FREIGHT_LOOKUP, dxFreightUrl, DxTracker } from './adapter.js';
import { dxWording, normalizeDxNumber, normalizeDxPostcode, parseDxFreight, parseDxLookupPage } from './parser.js';
import { dxMappedStage, dxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'L1234566';
const IN_TRANSIT = '12345678';
const POSTCODE = 'ZZ1 1ZZ';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const deliveredMenu = page('delivered-menu');
const deliveredHistory = page('delivered-history');
const transitMenu = page('in-transit-menu');
const transitHistory = page('in-transit-history');
const notFound = page('not-found');
const edit = (body: string, change: (document: ReturnType<typeof load>) => void) => { const $ = load(body); change($); return $.html(); };
const SESSION = 'ASP.NET_SessionId=synthetic0session0000001';
const MENU = '/track/Menu.aspx';
const HISTORY = '/track/Track.aspx';
const NOTICE = '/track/TrackingError.aspx';
const moved = (location: string | null, cookie: string | null = `${SESSION}; path=/; HttpOnly; SameSite=Lax`) => new Response(null, {
  status: 302, headers: { ...(location === null ? {} : { Location: location }), ...(cookie ? { 'Set-Cookie': cookie } : {}) },
});
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
/** The tracker's three answers: the lookup's redirect to the menu, the menu, then the history. */
const tracker = (history = deliveredHistory, menu = deliveredMenu) => vi.fn<typeof fetch>()
  .mockResolvedValueOnce(moved(MENU)).mockResolvedValueOnce(reply(menu)).mockResolvedValueOnce(reply(history));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failure = (pending: Promise<unknown>) => pending.then(() => undefined, (error: unknown) => error as Record<string, unknown>);
const CHECK = '<!DOCTYPE html><html><head><title>Access Denied</title></head><body>Reference #18.0</body></html>';

describe('DX Freight tracking adapter', () => {
  it('sends the number and postcode as the tracking page does, then reads the menu and history in the session the lookup opened', async () => {
    const fetcher = tracker();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' l123 4566 ', ' zz1   1zz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [lookupUrl, lookup] = fetcher.mock.calls[0]!;
    // The space stays `%20`: the tracker reads a `+` as part of the postcode.
    expect(String(lookupUrl)).toBe(`${DX_FREIGHT_LOOKUP}?consno=${DELIVERED}&postcode=ZZ1%201ZZ`);
    expect(lookup).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookup!.headers).not.toHaveProperty('Cookie');
    for (const [index, path] of [[1, MENU], [2, HISTORY]] as const) {
      const [url, init] = fetcher.mock.calls[index]!;
      expect(String(url)).toBe(`https://dx-track.com${path}`);
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0', Cookie: SESSION } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dx', step: 'direct', outcome: 'ok' }));
    expect(dxFreightUrl('12345678', 'd02x285')).toBe(`${DX_FREIGHT_LOOKUP}?consno=12345678&postcode=D02X285`);
  });

  it('reads a delivered history as wall clocks, without the signatory, the order number or a delivery date', () => {
    const result = normalizeCarrierResult(parseDxFreight(deliveredHistory, deliveredMenu, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '1 of 1 items delivered.', last_update: null, last_update_local: '2026-09-15T13:12:00', expected_delivery: null,
      service_name: 'Overnight', weight_kg: 12.5 });
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-09-15T13:12:00', '1 of 1 items delivered.', 'SAMPLETON', 'delivered', 'carrier_map'],
      ['2026-09-15T07:05:00', 'Scanned 1 of 1 items onto delivery vehicle.', 'SAMPLETON', 'out_for_delivery', 'carrier_map'],
      ['2026-09-15T03:44:00', 'Scan at delivery depot', 'SAMPLETON', 'in_transit', 'carrier_map'],
      ['2026-09-14T17:20:00', 'Scan at delivery depot', 'EXAMPLEFORD', 'in_transit', 'carrier_map'],
      ['2026-09-14T11:02:00', 'Data Received', 'EXAMPLEFORD', 'registered', 'carrier_map'],
    ]);
    expect(result.events?.every(event => !event.time && !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Signed|a sample|SO000001/);
    expect(dxWording(' 1 of 1 items  delivered.  Signed A. Name-Example ')).toBe('1 of 1 items delivered.');
    expect(dxWording('Signed for by a neighbour')).toBe('');
  });

  it("reads a consignment on its delivery vehicle with the menu's delivery day, in the year after the despatch that fits", () => {
    const result = parseDxFreight(transitHistory, transitMenu, IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Scanned 2 of 2 items onto delivery vehicle.', last_update_local: '2026-10-08T07:30:00',
      expected_delivery: '2026-10-08', service_name: 'Overnight', weight_kg: 41 });
    expect(result.events?.map(event => [event.local_time, event.stage])).toEqual([
      ['2026-10-08T07:30:00', 'out_for_delivery'], ['2026-10-08T02:10:00', 'in_transit'],
      ['2026-10-07T18:45:00', 'in_transit'], ['2026-10-07T12:15:00', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toContain('REF-0002');

    const newYear = edit(transitHistory, $ => {
      $('span[id$="_lbl_consdate"]').text('30/12/2026');
      $('table[id$="_StatusGridView"] tr').slice(1).each((index, row) => { $(row).children('td').first().text(`31/12/26 0${4 - index}:00 AM`); });
    });
    const day = (weekday: string, month: string) => edit(transitMenu, $ => {
      $('span[id$="_DaySpan"]').text(weekday);
      $('span[id$="_MonthSpan"]').text(month);
    });
    expect(parseDxFreight(newYear, day('Monday 4th', 'January'), IN_TRANSIT).expected_delivery).toBe('2027-01-04');
    // A weekday the calendar does not give that day, an unreadable day and a day long after the despatch say nothing.
    for (const menu of [day('Tuesday 4th', 'January'), day('Monday 4th', 'Janvier'), day('4 January', 'January'), day('Wednesday 30th', 'June')]) {
      expect(parseDxFreight(newYear, menu, IN_TRANSIT).expected_delivery).toBeNull();
    }
    // A day the newest scan has passed was missed; the menu has not moved it.
    expect(parseDxFreight(transitHistory, day('Wednesday 7th', 'October'), IN_TRANSIT).expected_delivery).toBeNull();
    const noDay = edit(transitMenu, $ => $('span[id$="_deliverydatediv"], div[id$="_deliverydatediv"]').remove());
    expect(parseDxFreight(transitHistory, noDay, IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('keeps a partial delivery in transit and turns an oldest-first history round', () => {
    const partial = edit(transitHistory, $ => {
      $('table[id$="_StatusGridView"] tr').eq(1).children('td').eq(1).text('1 of 2 items  delivered.  Signed a sample');
    });
    expect(parseDxFreight(partial, transitMenu, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: '1 of 2 items delivered.', expected_delivery: '2026-10-08' });
    const oldestFirst = edit(deliveredHistory, $ => {
      const table = $('table[id$="_StatusGridView"]');
      const body = table.children('tbody').length ? table.children('tbody') : table;
      for (const row of table.find('tr').slice(1).toArray().reverse()) body.append(row);
    });
    expect(parseDxFreight(oldestFirst, deliveredMenu, DELIVERED)).toMatchObject({ status: 'delivered', last_update_local: '2026-09-15T13:12:00',
      events: [{ local_time: '2026-09-15T13:12:00' }, expect.anything(), expect.anything(), expect.anything(), { description: 'Data Received' }] });
  });

  it("reads the tracker's notice as inconclusive, since a wrong postcode and an old delivery get it too", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(moved(NOTICE)).mockResolvedValueOnce(reply(notFound));
    const error = await failure(carrier(fetcher).track({ number: DELIVERED, postcode: POSTCODE }));
    expect(error).toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const page = vi.fn<typeof fetch>().mockResolvedValue(reply(notFound));
    await expect(carrier(page).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(() => parseDxLookupPage(notFound, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    // Another notice is a changed page.
    const other = edit(notFound, $ => $('span[id$="_Errorlbl"]').text('Service unavailable'));
    expect(() => parseDxLookupPage(other, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds both pages to the whole number: another consignment is inconclusive, never this one', async () => {
    const other = (body: string) => edit(body, $ => $('span[id$="_ConsNoLabel"]').text('L7654321'));
    await expect(carrier(tracker(other(deliveredHistory))).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(tracker(deliveredHistory, other(deliveredMenu))).track({ number: DELIVERED, postcode: POSTCODE }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseDxFreight(deliveredHistory, deliveredMenu, 'L1234568')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('asks nothing without the postcode, for a number another DX tracker reads, or for one DX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toBeInstanceOf(InputRequiredError);
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: null })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: '  ' })).rejects.toMatchObject({ kind: 'input_required' });
    for (const postcode of ['ZZ1/1ZZ', 'ZZ12 1ZZZ', 'ABCDEF']) {
      await expect(carrier(fetcher).track({ number: DELIVERED, postcode }), postcode).rejects.toBeInstanceOf(InvalidInputError);
    }
    // Network Services and secure delivery numbers are left to other sources.
    for (const number of ['123456789012', '1234567890', 'ABCD12345']) {
      await expect(carrier(fetcher).track({ number, postcode: POSTCODE }), number).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    for (const number of ['', 'L12', '!!!', `L${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number, postcode: POSTCODE }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: POSTCODE }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDxNumber('w 000-0001')).toBe('W0000001');
    expect(normalizeDxPostcode(' sw1a   1aa ')).toBe('SW1A 1AA');
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('reads a browser check or a refusal as a challenge, and keeps a rate limit as one', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK))).track({ number: DELIVERED, postcode: POSTCODE }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(tracker(CHECK)).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('Forbidden', 403))).track({ number: DELIVERED, postcode: POSTCODE }))
      .rejects.toMatchObject({ kind: 'challenge' });
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(carrier(limited).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    const later = vi.fn<typeof fetch>().mockResolvedValueOnce(moved(MENU)).mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(carrier(later).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps the postcode out of a failed lookup', async () => {
    for (const status of [500, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('Server Error', status));
      const error = await failure(carrier(fetcher).track({ number: DELIVERED, postcode: POSTCODE }));
      expect(error).toMatchObject({ kind: status === 503 ? 'maintenance' : 'indeterminate', status });
      expect(error!.request).toBeUndefined();
      expect(error!.diagnostics).toBeUndefined();
    }
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await failure(carrier(down).track({ number: DELIVERED, postcode: POSTCODE }));
    expect(error).toMatchObject({ kind: 'transport' });
    expect(error!.request).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('ZZ1');
  });

  it('reads a changed page, a strange redirect or a lost session as a failure, never as not found', async () => {
    const grid = 'table[id$="_StatusGridView"]';
    const changed = [
      '<html><body>Maintenance</body></html>',
      edit(deliveredHistory, $ => $('span[id$="_ConsNoLabel"]').text('N/A')),
      edit(deliveredHistory, $ => $('span[id$="_ConsNoLabel"]').clone().appendTo('body')),
      edit(deliveredHistory, $ => $(`${grid} th`).first().text('When')),
      edit(deliveredHistory, $ => $(`${grid} tr`).eq(1).children('td').last().remove()),
      edit(deliveredHistory, $ => $(`${grid} tr`).eq(1).children('td').first().text('15/09/2026 13:12')),
      edit(deliveredHistory, $ => $(`${grid} tr`).eq(1).children('td').first().text('31/02/26 01:12 PM')),
      edit(deliveredHistory, $ => $(grid).clone().appendTo('body')),
      edit(deliveredHistory, $ => $(grid).remove()),
    ];
    for (const body of changed) {
      expect(() => parseDxFreight(body, deliveredMenu, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = edit(deliveredHistory, $ => { $(grid).remove(); $('span[id$="_lbl_status"]').text(''); });
    expect(() => parseDxFreight(empty, deliveredMenu, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const headerOnly = edit(deliveredHistory, $ => $(`${grid} tr`).slice(1).remove());
    expect(() => parseDxFreight(headerOnly, deliveredMenu, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDxLookupPage(deliveredMenu, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));

    const lookup = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response)
      .mockResolvedValueOnce(reply(deliveredMenu)).mockResolvedValueOnce(reply(deliveredHistory));
    const failures: [Response, string][] = [
      [moved('/track/Other.aspx'), 'schema'],
      [moved('https://example.invalid/track/Menu.aspx'), 'schema'],
      [moved(`${MENU}?consno=${DELIVERED}`), 'schema'],
      [moved(null), 'schema'],
      [moved(MENU, null), 'indeterminate'],
      [moved(MENU, 'ASP.NET_SessionId=; path=/'), 'indeterminate'],
      [reply('Not found', 404), 'transport'],
      [reply(deliveredMenu), 'schema'],
    ];
    for (const [response, kind] of failures) {
      await expect(carrier(lookup(response)).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind });
    }
    await expect(carrier(lookup(moved(`https://dx-track.com${MENU}`))).track({ number: DELIVERED, postcode: POSTCODE }))
      .resolves.toMatchObject({ status: 'delivered' });
    // The tracker sends a session it no longer holds to its notice.
    const lost = vi.fn<typeof fetch>().mockResolvedValueOnce(moved(MENU)).mockResolvedValueOnce(reply(deliveredMenu))
      .mockResolvedValueOnce(moved(NOTICE, null));
    await expect(carrier(lost).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    const elsewhere = vi.fn<typeof fetch>().mockResolvedValueOnce(moved(MENU)).mockResolvedValueOnce(moved('/track/Other.aspx', null));
    await expect(carrier(elsewhere).track({ number: DELIVERED, postcode: POSTCODE })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('tries once more in a new session when the tracker cannot be reached, and ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(moved(MENU)).mockResolvedValueOnce(reply(deliveredMenu)).mockResolvedValueOnce(reply(deliveredHistory));
    await expect(carrier(fetcher).track({ number: DELIVERED, postcode: POSTCODE })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[1]![0])).toContain(DX_FREIGHT_LOOKUP);
    expect(fetcher.mock.calls[1]![1]!.headers).not.toHaveProperty('Cookie');

    const signals: AbortSignal[] = [];
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(hanging).track({ number: DELIVERED, postcode: POSTCODE }, { budgetMs: 40 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('routes a DX Freight number with its postcode to the adapter, and leaves one without it to other sources', async () => {
    const answers = () => vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/track/dx.aspx') return moved(MENU);
      return reply(url.pathname === MENU ? deliveredMenu : deliveredHistory);
    });
    const fetcher = answers();
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dx', postcode: 'zz1 1zz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dx', source: 'dx', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${DX_FREIGHT_LOOKUP}?consno=${DELIVERED}&postcode=ZZ1%201ZZ`)).toBe(true);
    const unasked = answers();
    await expect(createTracker({ fetcher: unasked, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dx' }, { budgetMs: 3000 }))
      .rejects.toMatchObject({ attempts: [{ source: 'dx', kind: 'input_required' }] });
    expect(unasked).not.toHaveBeenCalled();
  });
});

describe('DX numbers and postcode', () => {
  it('asks for a postcode beside a freight number only, and lets the form leave it empty', () => {
    expect(carrierDefinition('dx').tracking).toMatchObject({ adapter: 'dx', localClocks: true });
    expect(carrierDefinition('dx').tracking).not.toHaveProperty('recognition');
    const [requirement] = carrierRequirements('dx', DELIVERED);
    expect(requirement).toMatchObject({ field: 'postcode', validator: 'internationalPostcode', optional: true, autoComplete: 'postal-code' });
    expect(carrierRequirements('dx', IN_TRANSIT)).toHaveLength(1);
    for (const number of ['123456789012', '1234567890']) expect(carrierRequirements('dx', number), number).toEqual([]);
    expect(requirementSatisfied(requirement!, '  ')).toBe(true);
    for (const value of ['SW1A 1AA', 'sw1a1aa', 'M1 1AE', 'D02 X285', 'BT1 1AA']) expect(requirementSatisfied(requirement!, value), value).toBe(true);
    for (const value of ['ZZ1/1ZZ', 'SW1A 1AAA', 'ABCDEF', 'A']) expect(requirementSatisfied(requirement!, value), value).toBe(false);
    // Browsers compile the field's pattern with the `v` flag.
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
    expect(normalizeCarrierInputs('dx', DELIVERED, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs('dx', DELIVERED, '', ' sw1a  1aa ')).toEqual({ trackingUrl: null, postcode: 'SW1A 1AA' });
    expect(() => normalizeCarrierInputs('dx', DELIVERED, '', 'ZZ1/1ZZ')).toThrow('DX requires a valid delivery postcode');
  });
});

describe('DX status vocabulary', () => {
  it('maps every wording it recorded, by its counts, and answers the app by wording', () => {
    for (const entry of statuses.entries) expect(dxMappedStage(entry.wording), entry.wording).toBe(entry.stage);
    expect(dxMappedStage('Scanned 1 of 3 items onto delivery vehicle')).toBe('out_for_delivery');
    expect(dxMappedStage('2 of 3 items delivered.')).toBe('in_transit');
    for (const wording of ['0 of 0 items delivered.', '3 of 2 items delivered.', 'constructor', 'toString', 'Order']) {
      expect(dxMappedStage(wording), wording).toBeUndefined();
    }
    // Another wording falls to the shared rules.
    expect(dxStage('Out for delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(dxStage('Synthetic note')).toBeNull();
    expect(statusMap.stage(null, 'data received')).toBe('registered');
    expect(statusMap.stage('X1', 'data received')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dx', providerCode: null, description: '1 of 1 items delivered.' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'dx', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
