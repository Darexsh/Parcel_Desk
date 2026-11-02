import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parcelTrackingLinks } from '../../core/catalog/parcel.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TFM_EXPRESS_TRACKING, TfmExpressTracker } from './adapter.js';
import { normalizeTfmExpressNumber, parseTfmExpress } from './parser.js';
import { tfmExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000000001';
const IN_TRANSIT = '900000000002';
const UNKNOWN = '000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const changed = (name: string, from: string | RegExp, to: string) => edited(fixture(name), from, to);
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (html: string, number: string) => parseTfmExpress(html, number).events!
  .map((event) => [event.time, event.provider_code, event.stage ?? null, event.description]);
/** A history row as the page writes it. */
const row = (day: string, clock: string, status: string, activity = '') => `<tr>
  <td>${day} <span class="text-mute">${clock}</span></td>
  <td>${status}</td>
  <td>${activity}</td>
</tr>`;
/** The in-transit page with its history's rows replaced. */
const rows = (...lines: string[]) => changed('in-transit', /(<tbody>)(?![\s\S]*<tbody>)[\s\S]*?(<\/tbody>)/, `$1${lines.join('\n')}$2`);
const BLOCKED = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('TFM Express HTTP adapter', () => {
  it('posts the whole airwaybill with offset 0 to the tracking page once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TfmExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(TFM_EXPRESS_TRACKING);
    expect(url).toBe('https://customer.tfmex.com/Skybill/TrackSkybill');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      body: `AWB=${IN_TRANSIT}&clientTimeZoneOffSetHour=0` });
    expect(init.headers).toMatchObject({ Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' });
    expect(new Headers(init.headers).has('Cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tfm-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, with UTC clocks at Dubai’s offset', () => {
    const result = parseTfmExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered to Consignee', last_update: '2026-03-12T16:40:00+04:00', expected_delivery: null,
      delivered_at: '2026-03-12T16:40:00+04:00' });
    expect(timeline(fixture('delivered'), DELIVERED)).toEqual([
      ['2026-03-12T16:40:00+04:00', 'Delivered', 'delivered', 'Shipment delivered to Consignee'],
      ['2026-03-12T10:05:00+04:00', 'Out for Delivery', 'out_for_delivery', 'Shipment Out for Delivery'],
      ['2026-03-11T17:15:00+04:00', 'Consignee not available', 'failed_attempt', 'Not at Home/Office'],
      ['2026-03-11T10:02:00+04:00', 'Out for Delivery', 'out_for_delivery', 'Shipment Out for Delivery'],
      // A row repeated whole is kept once; a row without activity is described by its status.
      ['2026-03-11T00:30:00+04:00', 'Received at HUB', 'in_transit', 'Received at HUB'],
      ['2026-03-10T19:20:00+04:00', 'Picked up', 'accepted', 'Picked up'],
      ['2026-03-10T13:45:00+04:00', 'Shipment Created', 'registered', 'Shipment Created'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
  });

  it('reads a parcel at the hub as in transit', () => {
    const result = parseTfmExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received at HUB',
      last_update: '2026-09-05T02:52:00+04:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(3);
  });

  it('reads the page’s twelve-hour clocks and refuses a clock that is not one', () => {
    for (const [day, clock, time] of [['04 September 2026', '12:05 AM', '2026-09-04T04:05:00+04:00'],
      ['4 September 2026', '12:30 PM', '2026-09-04T16:30:00+04:00'], ['31 December 2026', '08:15 PM', '2027-01-01T00:15:00+04:00'],
      ['01 May 2026', '9:00 AM', '2026-05-01T13:00:00+04:00']] as const) {
      expect(parseTfmExpress(rows(row(day, clock, 'Received at HUB')), IN_TRANSIT).events![0]!.time, `${day} ${clock}`).toBe(time);
    }
    for (const [day, clock] of [['31 February 2026', '10:00 AM'], ['04 Sept 2026', '10:00 AM'], ['04 September 2026', '13:00 PM'],
      ['04 September 2026', '10:00'], ['2026-09-04', '10:00 AM'], ['', '']] as const) {
      expect(() => parseTfmExpress(rows(row(day, clock, 'Received at HUB')), IN_TRANSIT), `${day} ${clock}`)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('sorts a history listed oldest first, reversing the page’s order within a minute', () => {
    const html = rows(row('04 September 2026', '10:00 AM', 'Shipment Created'), row('04 September 2026', '02:00 PM', 'Picked up'),
      row('04 September 2026', '02:00 PM', 'Received at HUB'));
    expect(timeline(html, IN_TRANSIT).map(([time, code]) => [time, code])).toEqual([
      ['2026-09-04T18:00:00+04:00', 'Received at HUB'],
      ['2026-09-04T18:00:00+04:00', 'Picked up'],
      ['2026-09-04T14:00:00+04:00', 'Shipment Created'],
    ]);
  });

  it('stages a status the map does not know by its activity, and leaves unknown wording without a stage', () => {
    const returned = parseTfmExpress(rows(row('05 September 2026', '09:00 AM', 'Return to Shipper', 'Shipment returned to shipper'),
      row('04 September 2026', '10:00 AM', 'Shipment Created')), IN_TRANSIT);
    expect(returned.events![0]).toMatchObject({ provider_code: 'Return to Shipper', stage: 'returned' });
    expect(returned.events![0]!.stage_source).not.toBe('carrier_map');
    const strange = parseTfmExpress(rows(row('05 September 2026', '09:00 AM', 'Sample Status'),
      row('04 September 2026', '10:00 AM', 'Shipment Created')), IN_TRANSIT);
    expect(strange.events![0]).not.toHaveProperty('stage');
    expect(strange).toMatchObject({ current_stage: 'registered', last_status_text: 'Sample Status' });
  });

  it('keeps no phone number from an activity line', () => {
    const html = rows(row('05 September 2026', '09:00 AM', 'Consignee not available', 'Not at Home/Office, called +971 50 000 0000'),
      row('04 September 2026', '10:00 AM', 'Shipment Created'));
    expect(parseTfmExpress(html, IN_TRANSIT).events![0]).toMatchObject({ description: 'Not at Home/Office, called' });
    expect(JSON.stringify(parseTfmExpress(html, IN_TRANSIT))).not.toMatch(/000 0000/);
  });

  it('reads the tracker’s notice for an unknown airwaybill as not found, and a page without an answer as changed', () => {
    expect(() => parseTfmExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const bare = changed('not-found', /<div class="shipment-wrapper text-center" id="shipmentNotExists">[\s\S]*?<\/div>/, '');
    expect(() => parseTfmExpress(bare, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTfmExpress(changed('not-found', 'Shipment Not Found', 'Service unavailable'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a shipment only when the summary names the airwaybill asked', () => {
    expect(() => parseTfmExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'TFM Express answered for a different airwaybill' }));
    expect(() => parseTfmExpress(changed('in-transit', `>${IN_TRANSIT}<`, `>${IN_TRANSIT}0<`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'TFM Express answered for a different airwaybill' }));
    expect(() => parseTfmExpress(changed('in-transit', `>${IN_TRANSIT}<`, '><'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a shipment without history rows as no history', () => {
    expect(() => parseTfmExpress(rows(), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const summary = fixture('in-transit').match(/<div class="shipmentbox shipmentbox-summary">[\s\S]*?<\/ul>\s*<\/div>/)![0];
    for (const [index, html] of [
      '<html><title>TrackSkybill</title></html>',
      changed('in-transit', 'action="/Skybill/TrackSkybill"', 'action="/Skybill/Track"'),
      changed('in-transit', '<th width="50%" style="color:white;">Activity</th>', '<th>Remarks</th>'),
      changed('in-transit', 'class="shipmentbox shipmentbox-history"', 'class="shipmentbox"'),
      changed('in-transit', summary, summary + summary),
      rows('<tr><td>04 September 2026 <span class="text-mute">10:00 AM</span></td><td>Shipment Created</td></tr>'),
      rows(row('04 September 2026', '10:00 AM', '')),
      rows(row('04 September 2026', '10:00 AM', 'Shipment Created').repeat(501)),
    ].entries()) {
      expect(() => parseTfmExpress(html, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTfmExpress(BLOCKED, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps an unknown airwaybill, a refused form, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (reply: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply)).track({ number: UNKNOWN });
    await expect(lookup(page(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('', { status: 400 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('', { status: 302, headers: { Location: '/Home/Error' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><head><title>Access Denied</title></head><body>Request blocked.</body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><title>TFM Express</title><body>Under maintenance</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers TFM Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000000000', '9000000000011', 'A90000000001', 'TFM900000000', '9'.repeat(65), '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTfmExpressNumber(' 9000-0000-0002 ')).toBe(IN_TRANSIT);
  });

  it('recognizes a known airwaybill and the unknown-airwaybill answer, and asks nothing for a number TFM Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      page(fixture(String(init?.body).startsWith(`AWB=${DELIVERED}&`) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T12:40:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('90000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    await expect(carrier(limited).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => page(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an airwaybill filed under TFM Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'tfm-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tfm-express', source: 'tfm-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === TFM_EXPRESS_TRACKING
      && String(init?.body).startsWith(`AWB=${DELIVERED}&`))).toBe(true);
  });

  it('claims no twelve digits by their shape, and opens and reads the tracking page’s own link', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('tfm-express');
    const [link] = parcelTrackingLinks({ carrier: 'tfm-express', trackingNumber: DELIVERED });
    expect(link?.url).toBe(`https://customer.tfmex.com/Skybill/TrackSkybill?awb=${DELIVERED}`);
    expect(parseTrackingInput(link!.url)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'tfm-express' });
  });
});

describe('TFM Express status vocabulary', () => {
  it('records every status the tracker shows with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code: string; wording?: string; stage?: string }[]) {
      expect(statusMap.stage(normalizeStatusWording(entry.code), entry.wording ?? ''), entry.code).toBe(entry.stage);
      expect(tfmExpressStage(entry.code, entry.wording ?? ''), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage('RECEIVED AT HUB', '')).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'tfm-express', providerCode: 'Delivered', description: 'Shipment delivered to Consignee' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'tfm-express', providerCode: 'Sample Status', description: 'Sample' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
