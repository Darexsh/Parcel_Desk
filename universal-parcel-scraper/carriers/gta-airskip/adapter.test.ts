import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GTA_AIRSKIP_API, GtaAirskipTracker } from './adapter.js';
import { normalizeGtaAirskipNumber, parseGtaAirskip } from './parser.js';
import { gtaAirskipStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'GRS1234512345678901';
const RETURNED = 'GRG1234512345678901';
const IN_TRANSIT = 'GRS0000000000000000';
const UNKNOWN = 'GRG0000000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { Events: Row[] };
type Reply = Row & { Data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.Data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseGtaAirskip>) => result.events!.map((event) =>
  [event.local_time, event.provider_code, event.stage, event.location, event.description]);

describe('GTA AirSkip HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GtaAirskipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' grs12345 12345678901 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(GTA_AIRSKIP_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'x-account-key': 'Portal', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ PageSize: 1, Page: 1, TrackingNumbers: [DELIVERED], DateFilterType: 0, IncludeHistory: true });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gta-airskip', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, standard status and town, newest first, without hidden or repeated scans', () => {
    const result = parseGtaAirskip(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Completed Unloading at Delivery Location: Normal Status', last_update: null,
      last_update_local: '2026-03-06T17:45:50', expected_delivery: null, service_name: 'Select', weight_kg: 0.227 });
    expect(rows(result)).toEqual([
      ['2026-03-06T17:45:50', '13', 'delivered', 'Testford, NS', 'Completed Unloading at Delivery Location: Normal Status'],
      ['2026-03-06T12:30:40', '12', 'out_for_delivery', 'Testford, NS', 'Loaded on Truck: Normal Status'],
      ['2026-03-06T09:10:11', '8', 'in_transit', 'Testford, NS', 'Arrived at Terminal Location: Normal Status'],
      ['2026-03-05T23:58:01', '8', 'in_transit', 'Example Junction, NB', 'Arrived at Terminal Location: Normal Status'],
      ['2026-03-05T23:58:01', '8', 'in_transit', 'Example Junction, NB', 'Received from Prior Carrier: Normal Status'],
      // The discarded scan the page hides is left out, and the sort hub scan repeated a fraction of a second later is kept once.
      ['2026-03-04T13:20:10', '32', 'in_transit', 'Sampleville, ON', 'In Transit'],
      ['2026-03-04T13:20:10', '30', 'accepted', 'Sampleville, ON', 'Received at sort hub'],
      ['2026-03-02T15:04:05', '9', 'registered', undefined, 'Label Created'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Shipper|Recipient|Merchant)|Sample Lane|Example Road|SAMPLE|A0A|example\.invalid|photo|1\.5|Discard/);
  });

  it('reads a parcel sent back after a failed delivery, with the reason the driver gave', () => {
    const result = parseGtaAirskip(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Return at hub', last_update_local: '2026-01-16T23:40:25', service_name: 'Ground', weight_kg: 0.544 });
    expect(rows(result)).toEqual([
      ['2026-01-16T23:40:25', '21', 'returned', 'Sampleville, ON', 'Return at hub'],
      ['2026-01-16T03:40:50', '21', 'returned', undefined, 'RTO'],
      ['2026-01-15T10:40:20', '5', 'in_transit', undefined, 'Assigned to Last mile Driver for Delivery'],
      ['2026-01-15T00:10:00', '10', 'failed_attempt', undefined, 'Undelivered: Customer not available'],
      ['2026-01-14T19:15:00', '20', 'out_for_delivery', undefined, 'You are Next'],
      ['2026-01-14T19:10:00', '12', 'out_for_delivery', undefined, 'Driver out for Delivery'],
      ['2026-01-14T14:20:10', '12', 'out_for_delivery', undefined, 'Load Scan'],
      ['2026-01-14T05:30:40', '5', 'in_transit', undefined, 'Assigned to Last mile Driver for Delivery'],
      ['2026-01-14T01:20:30', '11', 'accepted', undefined, 'Inscanned at location'],
      ['2026-01-13T15:10:20', '11', 'accepted', 'Sampleville, ON', 'Received at sort hub'],
      ['2026-01-12T16:01:02', '9', 'registered', undefined, 'Label Created'],
    ]);
  });

  it('reads older scans without a standard status by their names, and the town before their reason', () => {
    const result = parseGtaAirskip(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delayed: Held for Consignee', last_update_local: '2026-02-05T02:22:36',
      expected_delivery: '2026-02-06', service_name: 'Select', weight_kg: 0.1 });
    expect(rows(result)).toEqual([
      // Two scans of one second keep the order of their fractions.
      ['2026-02-05T02:22:36', undefined, undefined, undefined, 'Shipment Delayed: Held for Consignee'],
      ['2026-02-05T02:22:36', undefined, 'in_transit', 'St. Example, ON', 'Arrived at Terminal Location: Business Closed'],
      ['2026-02-05T01:14:40', undefined, 'failed_attempt', undefined, 'Attempted Delivery AI Shipment has been Reconsigned: Business Closed'],
      ['2026-02-04T15:01:05', undefined, 'out_for_delivery', 'Testville, ON', 'Loaded on Truck: Normal Status'],
      ['2026-02-04T11:02:22', undefined, 'in_transit', 'St. Example, ON', 'Arrived at Terminal Location: Normal Status'],
      ['2026-02-03T23:21:51', undefined, 'in_transit', 'Sampleville, ON', 'Received from Prior Carrier: Normal Status'],
      ['2026-02-03T19:59:57', undefined, 'accepted', undefined, 'Received at sort hub'],
      ['2026-02-02T15:09:25', undefined, 'registered', undefined, 'Label Created'],
      ['2026-02-02T11:09:29', undefined, 'registered', undefined, 'Order Received'],
    ]);
  });

  it('takes the shipment’s standard status as the page does, unless the reply ends on a scan the page hides', () => {
    expect(parseGtaAirskip(changed('returned', (shipment) => { shipment.StandardStatus = 13; }), RETURNED))
      .toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Return at hub' });
    expect(parseGtaAirskip(changed('returned', (shipment) => {
      shipment.StandardStatus = 13;
      shipment.Events.push({ ...shipment.Events[0]!, StandardStatus: null, Name: 'Manual', EventDateTime: '2026-01-17T09:00:00' });
    }), RETURNED)).toMatchObject({ current_stage: 'returned', last_status_text: 'Return at hub' });
    // A delay notice moves nothing.
    expect(parseGtaAirskip(changed('returned', (shipment) => {
      shipment.StandardStatus = 2;
      shipment.Events.push({ ...shipment.Events[0]!, StandardStatus: 2, Type: 'Warning', Category: 'Delayed', Name: 'General Delay',
        EventDateTime: '2026-01-17T09:00:00' });
    }), RETURNED)).toMatchObject({ current_stage: 'returned', last_status_text: 'General Delay' });
  });

  it('keeps a reason or a place only when it holds no digit, and an offset the reply gives as an instant', () => {
    const result = parseGtaAirskip(changed('returned', (shipment) => {
      shipment.Events[7]!.Description = 'Call 000 000 0000';
      shipment.Events[1]!.Location = '1 Sample Street, Sampleville, ON';
      shipment.Events[10]!.EventDateTime = '2026-01-16T23:40:25.857Z';
    }), RETURNED);
    expect(result.events![0]).toMatchObject({ time: '2026-01-16T23:40:25.857Z', description: 'Return at hub' });
    expect(result.events![0]).not.toHaveProperty('local_time');
    expect(result).toMatchObject({ last_update: '2026-01-16T23:40:25.857Z' });
    expect(result.events!.find((event) => event.provider_code === '10')).toMatchObject({ description: 'Undelivered' });
    expect(result.events!.at(-2)).not.toHaveProperty('location');
  });

  it('reads an empty list as not found and a refused lookup as inconclusive', () => {
    expect(() => parseGtaAirskip(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGtaAirskip({ Data: null, IsSuccess: false, ErrorMessage: 'Synthetic failure' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGtaAirskip(changed('delivered', (shipment) => { shipment.Events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseGtaAirskip(changed('delivered', (shipment) => { delete (shipment as Row).Events; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseGtaAirskip(changed('delivered', (shipment) => { shipment.Events = [{ ...shipment.Events[4]! }]; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its number is the one asked', () => {
    expect(() => parseGtaAirskip(fixture('returned'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GTA AirSkip answered for another shipment' }));
    // A second shipment under the same number leaves it unclear which one is meant.
    expect(() => parseGtaAirskip(changed('returned', (_shipment, body) => { body.Data.push(body.Data[0]!); }), RETURNED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another shipment beside the one asked is left out.
    const beside = parseGtaAirskip(changed('returned', (_shipment, body) => { body.Data.unshift(fixture('delivered').Data[0]!); }), RETURNED);
    expect(beside.events).toHaveLength(11);
    expect(parseGtaAirskip(changed('returned', (shipment) => { shipment.TrackingNumber = ` ${RETURNED.toLowerCase()} `; }), RETURNED).events)
      .toHaveLength(11);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).IsSuccess; },
      (_shipment: Shipment, body: Reply) => { body.IsSuccess = 'true'; },
      (_shipment: Shipment, body: Reply) => { delete (body as Row).Data; },
      (_shipment: Shipment, body: Reply) => { body.Data = 'shipments' as never; },
      (_shipment: Shipment, body: Reply) => { body.Data = Array.from({ length: 31 }, () => body.Data[0]!); },
      (_shipment: Shipment, body: Reply) => { body.Data[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.TrackingNumber; },
      (shipment: Shipment) => { shipment.TrackingNumber = 7; },
      (shipment: Shipment) => { shipment.StandardStatus = '21'; },
      (shipment: Shipment) => { shipment.Events = 'scans' as never; },
      (shipment: Shipment) => { shipment.Events = Array.from({ length: 501 }, () => shipment.Events[0]!); },
      (shipment: Shipment) => { shipment.Events[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.Events[0]!.EventDateTime = '01/12/2026 16:01'; },
      (shipment: Shipment) => { shipment.Events[0]!.EventDateTime = '2026-02-30T16:01:02'; },
      (shipment: Shipment) => { shipment.Events[0]!.EventDateTime = '2026-01-12T24:00:00'; },
      (shipment: Shipment) => { shipment.Events[0]!.EventDateTime = '2026-01-12T16:01:02+99:00'; },
      (shipment: Shipment) => { delete shipment.Events[0]!.EventDateTime; },
      (shipment: Shipment) => { shipment.Events[0]!.StandardStatus = -1; },
      (shipment: Shipment) => { shipment.Events[0]!.StandardStatus = 9.5; },
      (shipment: Shipment) => { shipment.Events[0]!.Name = ''; shipment.Events[0]!.Category = ''; },
      (shipment: Shipment) => { shipment.Events[0]!.Name = ['Label Created']; },
      (shipment: Shipment) => { shipment.Events[1]!.Location = 7; },
      (shipment: Shipment) => { shipment.Service = {}; },
    ]) {
      expect(() => parseGtaAirskip(changed('returned', change), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(reply(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('', { status: 301, headers: { Location: 'https://gtaairskip.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>GTA AirSkip</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: RETURNED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(RETURNED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that failed to reach GTA AirSkip once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('returned')));
    await expect(carrier(fetcher).track({ number: RETURNED })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A reply is never sent again.
    const answered = vi.fn<typeof fetch>().mockImplementation(async () => reply({ Data: null, IsSuccess: false, ErrorMessage: 'Synthetic failure' }));
    await expect(carrier(answered).track({ number: RETURNED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number GTA AirSkip does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T17:45:50' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('GRX0000000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers GTA AirSkip does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GRG000000000000000', 'GRG00000000000000000', 'GRX0000000000000000', 'GRG0000A000000000000', 'GRG0000000000000000,GRG0000000000000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: RETURNED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGtaAirskipNumber('grg 12345-12345 678901')).toBe(RETURNED);
  });

  it('routes a number filed under GTA AirSkip to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'gta-airskip' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gta-airskip', source: 'gta-airskip', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === GTA_AIRSKIP_API)).toBe(true);
  });
});

describe('GTA AirSkip status vocabulary', () => {
  it('records every standard status and scan name with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[]) {
      // The page's progress steps are not scans.
      if (!entry.code && entry.confirmedBy === 'portal') continue;
      expect(gtaAirskipStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
      const mapped = statusMap.stage(entry.code ?? null, entry.wording.toLowerCase());
      if (mapped) expect(mapped, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gta-airskip', providerCode: '10', description: 'Undelivered: Customer not available' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'gta-airskip', providerCode: '1', description: 'Weather Delay' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'gta-airskip', providerCode: '9001', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A standard status the map does not know is staged by the scan's name, then by the shared wording rules.
    expect(gtaAirskipStage('9001', 'Loaded on Truck: Normal Status')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(gtaAirskipStage('', 'Shipment Delayed: Incorrect Address')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(gtaAirskipStage('', 'Synthetic note')).toBeNull();
  });
});
