import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, QUANTIUM_API, QUANTIUM_QUERY, QuantiumTracker } from './adapter.js';
import { normalizeQuantiumNumber, parseQuantium, quantiumWording } from './parser.js';
import { quantiumMappedStage, quantiumStage, quantiumWordingStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RQ123456789SG';
const PARTNER = 'ZZ000000000XX';
const IN_TRANSIT = '1234067891';
const UNKNOWN = 'UQ000000000TH';

type Shipment = Record<string, unknown> & { history: unknown };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment[];
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
const history = (rows: [string, string, string][]) => `<history_list>${rows.map(([milestone, clock, remark]) =>
  `<history><status_desc>${milestone}</status_desc><status_date>${clock}</status_date><remark>${remark}</remark></history>`).join('')}</history_list>`;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Quantium Solutions HTTP adapter', () => {
  it('asks the tracking page’s stored query for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new QuantiumTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123-406 7891 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(QUANTIUM_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/json; charset=UTF-8' } });
    expect(JSON.parse(String(init!.body))).toEqual({ query_name: QUANTIUM_QUERY, query_json: `{"cust_code":"","order_no":"${IN_TRANSIT}"}` });
    expect(QUANTIUM_QUERY).toBe('itcms_sql\\d_order_track');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'quantium-solutions', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps every scan once as a wall clock, newest first, with its remark where it says more', () => {
    const result = parseQuantium(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered', last_update: null, last_update_local: '2026-03-12T14:20:05', expected_delivery: null,
      destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage ?? null])).toEqual([
      ['2026-03-12T14:20:05', 'Shipment delivered', 'delivered'],
      ['2026-03-12T08:40:12', 'Shipment out for delivery', 'out_for_delivery'],
      ['2026-03-12T04:15:00', 'IN TRANSIT', 'in_transit'],
      ['2026-03-11T07:50:00', 'IN TRANSIT', 'in_transit'],
      ['2026-03-09T05:12:44', 'Shipment received at delivery branch: Handed Over for Delivery', 'in_transit'],
      ['2026-03-09T01:05:44', 'Shipment released from customs/ government check point: Customs Cleared', 'in_transit'],
      ['2026-03-07T12:00:00', 'IN TRANSIT: Customs Clearance Begins', 'customs'],
      ['2026-03-06T13:30:00', 'Shipment arrived at destination port: Arrive Destination', 'in_transit'],
      ['2026-03-06T02:45:00', 'FLIGHT DEPARTURE TO DESTINATION', 'in_transit'],
      ['2026-03-05T21:10:00', 'READY FOR DEPARTURE', 'in_transit'],
      ['2026-03-04T18:02:17', 'Shipment despatched to overseas: Depart Hub', 'in_transit'],
      ['2026-03-04T17:44:51', 'Shipment received at transshipment hub: Arrive Hub', 'in_transit'],
      // The scan listed twice is kept once.
      ['2026-03-04T15:20:09', 'DEPART ORIGIN', 'in_transit'],
      // A fraction of a second is dropped.
      ['2026-03-02T11:05:30', 'Shipment despatched to transshipment hub', 'in_transit'],
      ['2026-03-01T19:00:01', 'Shipment under processing at origin hub', 'in_transit'],
      ['2026-03-01T19:00:01', 'Shipment received', 'accepted'],
      ['2026-02-28T13:00:00', 'Shipment created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map' && !event.provider_code)).toBe(true);
    // Neither party's name or address, nor the states, references or the partner's number, is kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|EXAMPLE|TESTVILLE|TESTTOWN|0000000000|ZZ000000000XX|Malaysia/);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('reads a parcel at destination customs, and an oldest-first history turned round', () => {
    const result = parseQuantium(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'IN TRANSIT: Customs Clearance Begins',
      last_update_local: '2026-05-20T14:02:00', destination_country: 'AU' });
    expect(result).not.toHaveProperty('delivered_at');
    const reversed = parseQuantium(changed('in-transit', (shipment) => {
      const rows = (shipment.history as string).match(/<history>.*?<\/history>/g)!;
      shipment.history = `<history_list>${rows.reverse().join('')}</history_list>`;
    }), IN_TRANSIT);
    expect(reversed.events).toEqual(result.events);
    const named = parseQuantium(changed('in-transit', (shipment) => { shipment.cnee_country = 'XX'; shipment.cnee_country_name = 'Sampleland'; }), IN_TRANSIT);
    expect(named).toMatchObject({ destination_country_name: 'Sampleland' });
    const none = parseQuantium(changed('in-transit', (shipment) => { shipment.cnee_country = null; shipment.cnee_country_name = ''; }), IN_TRANSIT);
    expect(none).not.toHaveProperty('destination_country');
    expect(none).not.toHaveProperty('destination_country_name');
  });

  it('reads a history the reply already lists, decodes its entities and keeps a remark-only scan', () => {
    const listed = parseQuantium(changed('in-transit', (shipment) => {
      shipment.history = [
        { status_desc: 'IN TRANSIT', status_date: '2026-05-21T09:00:00', remark: 'Delivery attempted, recipient not available' },
        { status_desc: 'IN TRANSIT', status_date: '2026-05-20T18:00:00', remark: 'Synthetic note' },
        { status_desc: '', status_date: '2026-05-20T14:02:00', remark: 'Customs Clearance Begins' },
      ];
    }), IN_TRANSIT);
    expect(listed.events!.map((event) => [event.description, event.stage ?? null, event.stage_source ?? null])).toEqual([
      // The catch-all milestone with a remark the map does not know: the remark's wording rules, else the milestone.
      ['IN TRANSIT: Delivery attempted, recipient not available', 'failed_attempt', 'wording:language'],
      ['IN TRANSIT: Synthetic note', 'in_transit', 'carrier_map'],
      ['Customs Clearance Begins', 'customs', 'carrier_map'],
    ]);
    const entities = parseQuantium(changed('in-transit', (shipment) => {
      shipment.history = history([['Shipment arrived at destination port', '2026-05-20T08:45:00', 'Arrive Destination &amp; Hub']]);
    }), IN_TRANSIT);
    expect(entities.events![0]).toMatchObject({ description: 'Shipment arrived at destination port: Arrive Destination & Hub' });
  });

  it('keeps the wording as the page shows it, without who took the parcel or phone numbers', () => {
    expect(quantiumWording('Shipment delivered', 'Received by Sample Person')).toMatchObject({ description: 'Shipment delivered' });
    expect(quantiumWording('Shipment delivered', 'Delivered to Sample Person, front door')).toMatchObject({ description: 'Shipment delivered' });
    expect(quantiumWording('IN TRANSIT', 'Call +60 00-000 0000 to arrange')).toMatchObject({ description: 'IN TRANSIT: Call to arrange' });
    expect(quantiumWording('Shipment out for delivery', 'Out for Delivery')).toMatchObject({ description: 'Shipment out for delivery' });
    expect(quantiumWording('', '')).toMatchObject({ description: '' });
  });

  it('answers a shipment asked by the tracking number the page prints beside it, and nothing it cannot bind', () => {
    expect(parseQuantium(fixture('delivered'), PARTNER)).toMatchObject({ current_stage: 'delivered' });
    const lines = changed('delivered', (shipment) => { shipment.co_loader_track_no = `ZZ123456789XX\r\n${PARTNER}`; });
    expect(parseQuantium(lines, PARTNER)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseQuantium(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Quantium answered for another shipment' }));
    // A client reference the reply names does not bind it.
    expect(() => parseQuantium(changed('delivered', (shipment) => { shipment.cst_ref_no = UNKNOWN; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = changed('delivered', (_shipment, reply) => { reply.push({ ...reply[0]!, order_id: 'HK000000002' }); });
    expect(() => parseQuantium(twice, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Quantium answered with several shipments for the number' }));
    // The shipment under the number's own order number wins over one that prints it as a tracking number.
    const both = changed('delivered', (_shipment, reply) => {
      reply.push({ ...changed('in-transit', () => undefined)[0]!, co_loader_track_no: DELIVERED });
    });
    expect(parseQuantium(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a shipment without scans by its current status, and one without either as no history', () => {
    const summary = parseQuantium(changed('in-transit', (shipment) => { shipment.history = ''; }), IN_TRANSIT);
    expect(summary).toMatchObject({ summary_only: true, status: 'in_transit', current_stage: 'in_transit', last_status_text: 'IN TRANSIT',
      last_update_local: '2026-05-20T14:02:00', events: [] });
    expect(() => parseQuantium(changed('in-transit', (shipment) => { shipment.history = '<history_list></history_list>'; shipment.status_desc = ''; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, change] of [
      (shipment: Shipment) => { shipment.history = 7; },
      (shipment: Shipment) => { shipment.history = '<history_list><history>'; },
      (shipment: Shipment) => { shipment.history = '<scans></scans>'; },
      (shipment: Shipment) => { shipment.history = '<history_list><scan/></history_list>'; },
      (shipment: Shipment) => { shipment.history = '<!DOCTYPE x><history_list></history_list>'; },
      (shipment: Shipment) => { shipment.history = history(Array.from({ length: 301 }, () => ['IN TRANSIT', '2026-05-20T08:45:00', ''] as [string, string, string])); },
      (shipment: Shipment) => { shipment.history = history([['IN TRANSIT', '2026-05-20 08:45', '']]); },
      (shipment: Shipment) => { shipment.history = history([['IN TRANSIT', '2026-02-30T08:45:00', '']]); },
      (shipment: Shipment) => { shipment.history = history([['IN TRANSIT', '2026-05-20T24:00:00', '']]); },
      (shipment: Shipment) => { shipment.history = history([['IN TRANSIT', '2026-05-20T08:45:00+08:00', '']]); },
      (shipment: Shipment) => { shipment.history = history([['IN TRANSIT', '', '']]); },
      (shipment: Shipment) => { shipment.history = history([['', '2026-05-20T08:45:00', '']]); },
      (shipment: Shipment) => { shipment.history = '<history_list><history><status_desc><b>IN TRANSIT</b></status_desc></history></history_list>'; },
      (shipment: Shipment) => { shipment.history = [{ status_desc: ['IN TRANSIT'], status_date: '2026-05-20T08:45:00' }]; },
      (shipment: Shipment) => { shipment.history = ['scan']; },
      (shipment: Shipment) => { shipment.order_no = 1234567890; },
      (shipment: Shipment) => { shipment.cnee_country = { code: 'AU' }; },
    ].entries()) {
      expect(() => parseQuantium(changed('in-transit', change), IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseQuantium({}, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuantium(['shipment'], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuantium(Array.from({ length: 21 }, () => fixture('in-transit')[0]), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, the service’s failure, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(json(fixture('service-error')))).rejects.toMatchObject({ kind: 'indeterminate', message: 'Quantium did not complete the lookup' });
    await expect(lookup(json(fixture('service-error'), { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('<html><body>Forbidden</body></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://itapps.quantiumworldwide.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(CLOUDFLARE, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Quantium</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Quantium does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('delivered'))).mockResolvedValueOnce(json(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:20:05' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('UQM-MU00000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses what Quantium does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456789', '12345678901', 'UQ12345678TH', 'UQ1234567890TH', 'UQM-MU00000000', 'UQT-TU-00000000', 'U0123456789TH', `UQ${'0'.repeat(60)}TH`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeQuantiumNumber('rq 123 456 789 sg')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under Quantium Solutions to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'quantium-solutions' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'quantium-solutions', source: 'quantium-solutions', result: { current_stage: 'customs' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === QUANTIUM_API)).toBe(true);
  });

  it('names Quantium for its tracker’s links, the result its page frames among them', () => {
    for (const link of [`https://track.quantiumworldwide.com/?trackno=${IN_TRANSIT}`,
      `https://itapps.quantiumworldwide.com/itcms_tracking/home/itcms?as_order_no=${IN_TRANSIT}`,
      `https://itapps.quantiumworldwide.com/itcms_tracking/Widget/order_track?as_lang_code=0&as_order_no=${IN_TRANSIT}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'quantium-solutions', source: 'link' });
    }
  });
});

describe('Quantium Solutions status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'quantium-solutions', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(quantiumWordingStage(entry.wording), entry.wording).toBe(entry.stage);
    }
  });

  it('lets a remark decide, and leaves the catch-all milestone open under a remark it does not know', () => {
    expect(quantiumMappedStage('IN TRANSIT', 'Customs Clearance Begins')).toBe('customs');
    expect(quantiumMappedStage('Shipment delivered', 'Delivered')).toBe('delivered');
    expect(quantiumMappedStage('IN TRANSIT', 'Synthetic note')).toBeUndefined();
    expect(quantiumMappedStage('Shipment received', 'Synthetic note')).toBe('accepted');
    expect(quantiumWordingStage('in transit: synthetic note')).toBeUndefined();
    expect(quantiumWordingStage('out for delivery')).toBe('out_for_delivery');
    expect(quantiumStage('IN TRANSIT', 'Delivery attempted, recipient not available')).toMatchObject({ stage: 'failed_attempt' });
    expect(quantiumStage('Synthetic milestone', '')).toBeNull();
    expect(quantiumStage('', '')).toBeNull();
  });
});
