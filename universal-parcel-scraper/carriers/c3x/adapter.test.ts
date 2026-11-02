import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, C3X_API, C3xTracker } from './adapter.js';
import { normalizeC3xNumber, parseC3x } from './parser.js';
import { c3xStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '3000000000';
const IN_TRANSIT = '4000000000';
const UNKNOWN = '1000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { TrackingLogDetails: Row[] };
type Reply = Row & { statusCode: unknown; data: Row & { Code: unknown; AirwayBillTrackList: Shipment[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.AirwayBillTrackList[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('C3X HTTP adapter', () => {
  it('posts the whole airwaybill to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new C3xTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 400-000 0000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(C3X_API);
    expect(String(url)).toBe('https://api.c3x.ae/api/Tracking');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ TrackingAWB: [{ AirWayBillNo: IN_TRANSIT }] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'c3x', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel as wall clocks, newest first, without who took it or the shipper’s references', () => {
    const result = normalizeCarrierResult(parseC3x(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-09-15T14:25:00', expected_delivery: null,
      destination_country: 'AE' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-09-15T14:25:00', 'ABU DHABI', 'POD', 'delivered', 'Delivered'],
      ['2026-09-15T06:40:00', 'ABU DHABI', 'WC', 'out_for_delivery', 'With Delivery Courier'],
      ['2026-09-14T22:05:00', 'DUBAI', 'INF', 'registered', 'Shipment Information Received'],
      ['2026-09-14T02:15:00', 'DUBAI', 'AF', 'in_transit', 'Arrived Facility'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('weight_kg');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECEIVER|SYN-ORDER|SHARJAH|2\.500|Attempt/);
  });

  it('reads a parcel at C3X’s facility and hands its forwarding number on', () => {
    const result = parseC3x(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-10-06T09:30:00',
      last_status_text: 'Arrived Facility', delivery_tracking_number: 'SYN0000000001', destination_country: 'IN' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events).toHaveLength(2);
    // No forwarding agent is named: the number's own rules decide whether a confirmation lookup is proposed.
    expect(deliveryHandoff('c3x', IN_TRANSIT, normalizeCarrierResult(result))).toBeNull();
    const postal = normalizeCarrierResult(parseC3x(changed('in-transit', (shipment) => { shipment.ForwardingNumber = 'RR000000005IN'; }), IN_TRANSIT));
    expect(deliveryHandoff('c3x', IN_TRANSIT, postal)).toEqual({ carrier: 'india-post', number: 'RR000000005IN', basis: 'reference' });
  });

  it('keeps only one whole forwarding number other than the airwaybill', () => {
    for (const forwarding of ['', null, IN_TRANSIT, 'AB1', 'SYN0000000001 / SYN0000000002', 'SYN 0000000001']) {
      expect(parseC3x(changed('in-transit', (shipment) => { shipment.ForwardingNumber = forwarding; }), IN_TRANSIT))
        .not.toHaveProperty('delivery_tracking_number');
    }
    expect(parseC3x(changed('in-transit', (shipment) => { shipment.ForwardingNumber = ' syn0000000001 '; }), IN_TRANSIT).delivery_tracking_number)
      .toBe('SYN0000000001');
  });

  it('does not take a moving parcel back when its details arrive after it', () => {
    const result = parseC3x(changed('delivered', (shipment) => { shipment.TrackingLogDetails.splice(0, 2); }), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment Information Received',
      last_update_local: '2026-09-14T22:05:00' });
    const registered = parseC3x(changed('in-transit', (shipment) => { shipment.TrackingLogDetails.splice(0, 1); }), IN_TRANSIT);
    expect(registered).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('reads the country of a destination, else keeps its name', () => {
    const country = (value: unknown) => {
      const result = parseC3x(changed('in-transit', (shipment) => { shipment.Destination = value; }), IN_TRANSIT);
      return [result.destination_country ?? null, result.destination_country_name ?? null];
    };
    expect(country('UMM AL-QUWAIN-UNITED ARAB EMIRATES')).toEqual(['AE', null]);
    expect(country('BISSAU-GUINEA-BISSAU')).toEqual(['GW', null]);
    expect(country('SYNTHETIC CITY-SYNTHETICLAND')).toEqual([null, 'SYNTHETICLAND']);
    expect(country('DUBAI')).toEqual([null, null]);
    expect(country(null)).toEqual([null, null]);
  });

  it('turns an oldest-first reply round, drops a repeated scan and reads an unknown code by its wording', () => {
    const turned = parseC3x(changed('delivered', (shipment) => {
      shipment.TrackingLogDetails.reverse();
      shipment.TrackingLogDetails.push({ ...shipment.TrackingLogDetails.at(-1)! });
    }), DELIVERED);
    expect(turned.events!.map((event) => event.provider_code)).toEqual(['POD', 'WC', 'INF', 'AF']);
    const worded = parseC3x(changed('in-transit', (shipment) => {
      shipment.TrackingLogDetails.unshift(
        { ActivityDate: 'Wednesday 07  October  2026', ActivityTime: '11:00', DeliveredTo: '', Location: '', Remarks: 'Synthetic note', Status: '' },
        { ActivityDate: 'Wednesday 07  October  2026', ActivityTime: '10:00', DeliveredTo: '', Location: 'DUBAI', Remarks: 'Departed Facility', Status: 'SYN' },
      );
    }), IN_TRANSIT);
    expect(worded.events![0]).toEqual({ local_time: '2026-10-07T11:00:00', description: 'Synthetic note' });
    expect(worded.events![1]).toMatchObject({ provider_code: 'SYN', stage: 'in_transit', stage_source: expect.stringMatching(/^wording/) });
    expect(worded).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
  });

  it('drops phone numbers from a scan’s wording', () => {
    const result = parseC3x(changed('in-transit', (shipment) => {
      shipment.TrackingLogDetails[0]!.Remarks = 'Arrived Facility - call +971 50 000 0000';
    }), IN_TRANSIT);
    expect(result.events![0]!.description).toBe('Arrived Facility - call');
  });

  it('reads a known airwaybill without scans as no history', () => {
    for (const rows of [[], null]) {
      expect(() => parseC3x(changed('in-transit', (shipment) => { shipment.TrackingLogDetails = rows as never; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects an answer for another shipment', () => {
    for (const other of ['4000000001', '04000000000', '']) {
      expect(() => parseC3x(changed('in-transit', (shipment) => { shipment.AirWayBillNo = other; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The entry for the number asked counts, wherever it is in the list.
    const listed = changed('in-transit', (_shipment, body) => {
      body.data.AirwayBillTrackList.unshift({ ...fixture('not-found').data.AirwayBillTrackList[0]!, AirWayBillNo: '4000000001' });
    });
    expect(parseC3x(listed, IN_TRANSIT).events).toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Partial<Reply>).statusCode; },
      (_shipment: Shipment, body: Reply) => { body.data = null as never; },
      (_shipment: Shipment, body: Reply) => { body.data.AirwayBillTrackList = 'shipments' as never; },
      (_shipment: Shipment, body: Reply) => { body.data.AirwayBillTrackList = []; },
      (_shipment: Shipment, body: Reply) => { body.data.AirwayBillTrackList = Array.from({ length: 11 }, () => body.data.AirwayBillTrackList[0]!); },
      (_shipment: Shipment, body: Reply) => { body.data.AirwayBillTrackList.push('shipment' as never); },
      (shipment: Shipment) => { delete shipment.AirWayBillNo; },
      (shipment: Shipment) => { shipment.AirWayBillNo = 4000000000; },
      (shipment: Shipment) => { shipment.TrackingLogDetails = 'scans' as never; },
      (shipment: Shipment) => { shipment.TrackingLogDetails = Array.from({ length: 301 }, () => shipment.TrackingLogDetails[0]!); },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.Status = 'Arrived'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.Status = 7; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.Remarks = ''; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.Remarks = { en: 'Arrived' }; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.Location = 5; },
      (shipment: Shipment) => { shipment.ForwardingNumber = 5; },
      (shipment: Shipment) => { delete shipment.TrackingLogDetails[0]!.ActivityDate; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityDate = '2026-10-06'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityDate = 'Monday 06  October  2026'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityDate = 'Saturday 31  October  2026 extra'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityDate = 'Thursday 31  September  2026'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityTime = '9:30'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityTime = '24:00'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityTime = '09:30+04:00'; },
      (shipment: Shipment) => { shipment.TrackingLogDetails[0]!.ActivityTime = 930; },
    ]) {
      expect(() => parseC3x(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseC3x('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the number echoed with nothing else as not found, and recognizes by the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A local clock dates the last activity without an instant.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-15T14:25:00' });
  });

  it('keeps a failed lookup, a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    // C3X's own failure, passed on by the service, is no answer about the parcel.
    const failed = { statusCode: 400, message: 'Synthetic failure' };
    await expect(lookup(reply(failed, { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(failed, { status: 400 }))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply({ statusCode: 200, message: 'Success', data: { Code: -1, Description: 'Synthetic failure' } })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('<!DOCTYPE html><html><head><title>Error</title></head><body><pre>Bad Request</pre></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('<!DOCTYPE html><html><body><pre>Cannot POST /api/Tracking</pre></body></html>', { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ statusCode: 403, message: 'Forbidden' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200 or 404, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CHECK, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<!DOCTYPE html><html><head><title>C3X</title></head><body><div id=root></div></body></html>', { status: 200 })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a redirect, which would answer for another request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://c3xpress.com/' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new C3xTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
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

  it('refuses numbers C3X does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['400000000', '40000000000', '400000000A', 'SYN0000000001', `${IN_TRANSIT},${DELIVERED}`, `${IN_TRANSIT}/1`,
      'RR000000005IN', '4'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeC3xNumber(' 400.000 0000 ')).toBe(IN_TRANSIT);
  });

  it('routes a number filed under C3X to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === C3X_API
      ? reply(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'c3x' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'c3x', source: 'c3x', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === C3X_API)).toBe(true);
  });
});

describe('C3X status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code: string; wording: string; stage?: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(c3xStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'c3x', providerCode: 'WC', description: 'With Delivery Courier' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'c3x', providerCode: 'SYN', description: 'Synthetic' })).toEqual({ kind: 'unknown' });
  });
});
