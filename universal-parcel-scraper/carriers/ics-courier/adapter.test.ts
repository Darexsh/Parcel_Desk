import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ICS_COURIER_ENDPOINT, IcsCourierTracker } from './adapter.js';
import { normalizeIcsCourierNumber, parseIcsCourier } from './parser.js';
import { icsCourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'GR123456789012A1A1A1';
const IN_TRANSIT = 'ND123456789012A1A1A1';
const SMARTSPOT = 'GR000000000000A0A0A0';
const LABEL = 'ND000000000000A1A1A1';
const UNKNOWN = 'ND000000000000A0A0A0';
const ID = '#ctl00_ctl00_ContentPlaceHolderDefault_TrackingMain_2_';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, change: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  change($);
  return $.html();
};
const scan = (clock: string, wording: string) => `<tr><td align="left">${clock}</td><td align="left">${wording}</td></tr>`;
const withScans = (name: string, ...rows: string[]) => changed(name, ($) => { $(`${ID}gvTracingDetail tr`).first().after(rows.join('')); });
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The recipient, the signatory, the signature, the shipper and the pickup point's hours and coordinates.
const PRIVATE = /SAMPLE RECIPIENT|EXAMPLE ST|A1A 1A1|"SAMPLE"|U1lOVEhF|base64|PUDO0000|Example Shop|Sample Sender|Rue Exemple|MON-FRI|12\.34567/;

describe('ICS Courier HTTP adapter', () => {
  it('asks the tracking page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IcsCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' nd1234-5678-9012 a1a 1a1 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ICS_COURIER_ENDPOINT}?trackNums=${IN_TRANSIT}`);
    expect(String(url)).toBe('https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=ND123456789012A1A1A1');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ics-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel as wall clocks in clock order, with branches but not the recipient or the signature', () => {
    const result = normalizeCarrierResult(parseIcsCourier(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-09-18T13:12:43', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-09-18T13:12:43', 'Delivered', undefined, 'delivered'],
      ['2026-09-18T07:22:23', 'Out for Delivery', undefined, 'out_for_delivery'],
      ['2026-09-18T04:16:07', 'In Sort Process', undefined, 'in_transit'],
      ['2026-09-18T04:16:05', 'At ICS Branch SPRINGFIELD, ON for processing', 'SPRINGFIELD, ON', 'in_transit'],
      // Recorded after the sort, under its earlier clock.
      ['2026-09-18T02:01:00', 'At ICS Branch SPRINGFIELD, ON for processing', 'SPRINGFIELD, ON', 'in_transit'],
      ['2026-09-17T16:22:04', 'In Transit', undefined, 'in_transit'],
      ['2026-09-17T16:21:59', 'At ICS Branch SHELBYVILLE, ON for processing', 'SHELBYVILLE, ON', 'in_transit'],
      ['2026-09-15T18:09:00', 'In Transit', undefined, 'in_transit'],
      ['2026-09-15T18:04:00', 'At ICS Branch OGDENVILLE, AB for processing', 'OGDENVILLE, AB', 'in_transit'],
      ['2026-09-15T17:15:32', 'Picked Up', undefined, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('pickup_point');
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('reads a parcel on its way with its estimated delivery day', () => {
    const result = parseIcsCourier(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update_local: '2026-10-05T17:34:00', expected_delivery: '2026-10-07' });
    expect(result.events!.map((event) => event.location ?? event.description)).toEqual(['In Transit', 'SHELBYVILLE, PQ', 'Picked Up']);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    // The estimate is stale once a later day's scan is in, and is no day at all when malformed.
    for (const estimate of ['2026-10-04', '2026-02-30', 'Pending', '']) {
      const stale = changed('in-transit', ($) => { $(`${ID}gvresult td`).eq(4).text(estimate); });
      expect(parseIcsCourier(stale, IN_TRANSIT).expected_delivery, estimate).toBeNull();
    }
  });

  it('reads a parcel left at a SMARTSpot with the point’s name and address, but not its hours or coordinates', () => {
    const result = normalizeCarrierResult(parseIcsCourier(fixture('smartspot'), SMARTSPOT));
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'At SMARTSpot for pickup',
      last_update_local: '2026-09-24T17:15:17', expected_delivery: null,
      pickup_point: 'EXAMPLE CORNER STORE\n1 SAMPLE AVE\nSPRINGFIELD, BC\nA0A0A0' });
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.stage])).toEqual([
      ['At SMARTSpot for pickup', 'ready_for_pickup'],
      ['Delivery Attempt: Consignee Not Available', 'failed_attempt'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/MON-FRI|12\.34567|EXAMPLE SPRINGFIELD|A0A 0A0/);
    // Without the SMARTSpot's row, or with a panel of another shape, there is no pickup point.
    const left = changed('smartspot', ($) => { $(`${ID}gvTracingDetail tr`).eq(1).remove(); });
    expect(parseIcsCourier(left, SMARTSPOT)).not.toHaveProperty('pickup_point');
    const named = changed('smartspot', ($) => { $(`${ID}lblAddress`).before('<br />EXAMPLE SECOND NAME<br />'); });
    expect(parseIcsCourier(named, SMARTSPOT)).not.toHaveProperty('pickup_point');
  });

  it('reads a label the shipper created as registered', () => {
    expect(parseIcsCourier(fixture('label-created'), LABEL)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Shipping label created', last_update_local: '2026-10-04T01:00:00', events: [{ stage: 'registered' }] });
  });

  it('keeps a driver’s reason without an address, drops repeated rows and reads unknown wording by the shared rules', () => {
    const result = parseIcsCourier(withScans('in-transit',
      scan('2026-10-06 12:00:00', 'Synthetic note'),
      scan('2026-10-06 11:00:00', 'Return: Incomplete Address'),
      scan('2026-10-06 10:00:00', 'Delivery Attempt: 1 Example St'),
      scan('2026-10-06 09:00:00', 'Delivery Attempt:'),
      scan('2026-10-05 17:34:00', 'In Transit'),
    ), IN_TRANSIT);
    expect(result.events!.slice(0, 5)).toEqual([
      { local_time: '2026-10-06T12:00:00', description: 'Synthetic note' },
      { local_time: '2026-10-06T11:00:00', description: 'Return: Incomplete Address', stage: 'exception', stage_source: expect.stringMatching(/^wording/) },
      { local_time: '2026-10-06T10:00:00', description: 'Delivery Attempt', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { local_time: '2026-10-06T09:00:00', description: 'Delivery Attempt', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { local_time: '2026-10-05T17:34:00', description: 'In Transit', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events).toHaveLength(7);
    expect(result).toMatchObject({ current_stage: 'exception', last_status_text: 'Synthetic note', expected_delivery: '2026-10-07' });
  });

  it('reads a found parcel without rows as no history', () => {
    const empty = changed('in-transit', ($) => { $(`${ID}gvTracingDetail tr`).slice(1).remove(); });
    expect(() => parseIcsCourier(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects an answer for another number', () => {
    expect(() => parseIcsCourier(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIcsCourier(fixture('not-found'), LABEL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = changed('in-transit', ($) => { $(`${ID}lblPinNumber`).text(LABEL); });
    expect(() => parseIcsCourier(other, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker echoes numbers in any case.
    const lower = changed('in-transit', ($) => { $(`${ID}gvresult a`).text(IN_TRANSIT.toLowerCase()); });
    expect(parseIcsCourier(lower, IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed page', () => {
    const many = Array.from({ length: 301 }, (_, index) => scan(`2026-10-06 ${String(index % 24).padStart(2, '0')}:00:${String(index % 60).padStart(2, '0')}`, `Synthetic ${index}`));
    for (const html of [
      changed('in-transit', ($) => { $(`${ID}gvresult`).remove(); }),
      changed('in-transit', ($) => { const row = $(`${ID}gvresult tr`).last(); row.after(row.clone()); }),
      changed('in-transit', ($) => { $(`${ID}gvresult td`).last().remove(); }),
      changed('in-transit', ($) => { $(`${ID}gvTracingDetail`).remove(); }),
      changed('in-transit', ($) => { const table = $(`${ID}gvTracingDetail`); table.after(table.clone()); }),
      changed('in-transit', ($) => { $(`${ID}pnlPinTrackingDetail`).attr('style', 'display:none;'); }),
      changed('in-transit', ($) => { $(`${ID}gvTracingDetail tr`).eq(1).append('<td>Synthetic</td>'); }),
      changed('in-transit', ($) => { $(`${ID}gvTracingDetail tr`).eq(1).children('td').last().text(''); }),
      withScans('in-transit', scan('2026-09-31 07:25:00', 'In Transit')),
      withScans('in-transit', scan('2026-10-06 24:00:00', 'In Transit')),
      withScans('in-transit', scan('2026-10-06 07:25', 'In Transit')),
      withScans('in-transit', scan('2026-10-06T07:25:00-04:00', 'In Transit')),
      withScans('in-transit', ...many),
      'reply',
    ]) {
      expect(() => parseIcsCourier(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A history for a number the tracker says it does not have.
    const history = load(fixture('in-transit'))(`${ID}gvTracingDetail`).toString();
    const contradicted = changed('not-found', ($) => { $(`${ID}pnlPinTrackingDetail`).append(history); });
    expect(() => parseIcsCourier(contradicted, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the tracker’s Not Found row as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps a failed lookup, a refusal, a moved route, a browser check and a broken page apart', async () => {
    const lookup = async (response: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const caught = await carrier(fetcher).track({ number: IN_TRANSIT }).catch((error: unknown) => error);
      expect(fetcher).toHaveBeenCalledTimes(1);
      return caught;
    };
    // ASP.NET sends a lookup that failed or ran out of time to its error page.
    await expect(lookup(new Response(null, { status: 302, headers: { Location: '/defaultError.aspx?aspxerrorpath=/online-services/parcel-tracking.aspx' } })))
      .resolves.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 301, headers: { Location: 'https://www.icscourier.ca/' } }))).resolves.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('<html><body>Not found</body></html>', { status: 404 }))).resolves.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).resolves.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('<html><body>Forbidden</body></html>', { status: 403 }))).resolves.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200, is never a missing parcel.
    await expect(lookup(page(CHECK))).resolves.toMatchObject({ kind: 'challenge' });
    const notice = changed('not-found', ($) => { $(`${ID}gvresult`).remove(); $(`${ID}lblError`).text('Synthetic notice'); });
    await expect(lookup(page(notice))).resolves.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(page('<!DOCTYPE html><html><head><title>ICS Courier</title></head><body></body></html>'))).resolves.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a lookup that does not reach the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new IcsCourierTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('stops the first try before the tracker gives up on its query, and finds the parcel on the retry', async () => {
    // The tracker's own 30-second limit, shortened: the first try's 25 seconds end at once.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const shortened = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === 25_000 ? 20 : ms));
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        }))
        .mockResolvedValueOnce(page(fixture('delivered')));
      await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60_000 })).resolves.toMatchObject({ current_stage: 'delivered' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(shortened).toHaveBeenCalledWith(25_000);
      // The retry gets the rest of the budget.
      expect(shortened.mock.calls.some(([ms]) => ms > 50_000 && ms < 60_000)).toBe(true);
    } finally {
      shortened.mockRestore();
    }
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
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses numbers ICS does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ND12345678901A1A1A1', 'ND1234567890123A1A1A1', 'XX123456789012A1A1A1', 'ND123456789012A1A1AA',
      'ND123456789012111111', `${IN_TRANSIT},${DELIVERED}`, `${IN_TRANSIT}*`, 'ND123456789012A1A1A1/../1', '', `ND${'0'.repeat(70)}A1A1A1`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIcsCourierNumber(' nd 1234.5678.9012 a1a 1a1 ')).toBe(IN_TRANSIT);
  });

  it('routes a number filed under ICS Courier to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(ICS_COURIER_ENDPOINT)
      ? page(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'ics-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ics-courier', source: 'ics-courier', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${ICS_COURIER_ENDPOINT}?trackNums=${IN_TRANSIT}`)).toBe(true);
  });
});

describe('ICS Courier status vocabulary', () => {
  // Staged by the shared wording rules rather than the map.
  const WORDED = new Set(['Return: Incomplete Address']);

  it('records every wording with the stage it gets', () => {
    const entries = statuses.entries as { wording: string; stage: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const mapped = statusMap.stage(null, normalizeStatusWording(entry.wording));
      expect(mapped, entry.wording).toBe(WORDED.has(entry.wording) ? undefined : entry.stage);
      expect(icsCourierStage(entry.wording), entry.wording).toEqual({ stage: entry.stage,
        source: WORDED.has(entry.wording) ? expect.stringMatching(/^wording/) : 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ics-courier', providerCode: null, description: 'Delivered at: SAMPLE RECIPIENT 1 EXAMPLE ST' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'ics-courier', providerCode: null, description: 'At ICS Branch SPRINGFIELD, ON for processing' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ics-courier', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'ics-courier', providerCode: 'SYN', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
