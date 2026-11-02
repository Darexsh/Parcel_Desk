import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PILOT_API, pilotLookupUrl, PilotFreightTracker } from './adapter.js';
import { normalizePilotNumber, parsePilot } from './parser.js';
import { pilotStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123456780';
const IN_TRANSIT = '987654321';
const UNKNOWN = '111222333';

type Row = Record<string, unknown>;
type Info = Row & { TrackingNumber: string; TrackingEventHistory: Row[]; LineItemList: Row[]; PackageConsignee: Row };
type Reply = { TrackingResponse: (Row & { TrackingInfo: Info; TrackingErrorInfo: Row })[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (info: Info, body: Reply) => void) => {
  const body = fixture(name);
  change(body.TrackingResponse[0]!.TrackingInfo, body);
  return body;
};
const transit = (change: (info: Info, body: Reply) => void) => changed('in-transit', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parsePilot>) => result.events!.map((event) => [event.time ?? event.local_time, event.description,
  event.stage ?? null, event.location ?? null, event.provider_code]);
// An event in the history's shape, at a hub in Ohio.
const row = (code: string, wording: string, when: string, type = 'GEN'): Row => ({ EventCode: code, EventCodeDesc: wording, EventType1: type,
  EventDateTime: when, EventLocation: { City: 'HUBVILLE', StateProvince: 'OH', PostalCode: '43997', CountryCode: 'US' },
  AdditionalLocationInfo: '', SignedForByName: '' });

describe('Pilot Freight Services HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole pro number once, in base64, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PilotFreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 987-654-321 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PILOT_API}OTg3NjU0MzIx/orgzip/0/dstzip/0/custnum/0`);
    expect(pilotLookupUrl('987 654 321')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pilot-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history, with instants only where the place keeps the reply’s offset, and nobody’s name', () => {
    const result = parsePilot(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-07-09T14:05:00-04:00', delivered_at: '2026-07-09T14:05:00-04:00', expected_delivery: null,
      service_name: 'Second Day', weight_kg: 70.534,
    });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('expected_delivery_from');
    // The repeated hub event is kept once. Texas keeps two zones, so its clocks stay wall clocks.
    expect(events(result)).toEqual([
      ['2026-07-09T14:05:00-04:00', 'Delivered', 'delivered', 'Exampleville, OH', 'DEL'],
      ['2026-07-09T08:12:40-04:00', 'Out For Delivery', 'out_for_delivery', 'Exampleville, OH', 'OFD'],
      ['2026-07-08T22:30:11-04:00', 'Arrived At Maersk Location', 'in_transit', 'Sample Junction, OH', 'REV'],
      ['2026-07-08T03:15:00-04:00', 'Departed Maersk Net Hub', 'in_transit', 'Hubville, OH', 'DNH'],
      ['2026-07-07T23:40:02-04:00', 'Received At Maersk Net Hub', 'in_transit', 'Hubville, OH', 'RNH'],
      ['2026-07-06T15:20:00', 'Picked Up', 'accepted', 'Sampleton, TX', 'PU'],
      ['2026-07-05T21:02:13', 'Waiting For Pickup', 'registered', 'Sampleton, TX', 'WPP'],
      ['2026-07-05T21:02:13', 'Shipment Information Sent To Maersk', 'registered', 'Sampleton, TX', 'NEW'],
      ['2026-07-05T21:02:13', 'Appointment Scheduled', null, null, 'APT'],
    ]);
    expect(result.events!.filter((event) => event.time).every((event) => !('local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLESON|FRONT PORCH|43999|79999|SAMPLE CABINET|SAMPLE RETAILER|SAMPLEORDER|555-01|STATION\.EXAMPLE|imaging|1000001/i);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('reads an in-transit history and the delivery window the service estimates', () => {
    const result = parsePilot(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Appointment Scheduled',
      last_update: null, last_update_local: '2026-01-21T09:30:00',
      expected_delivery: '2026-01-23T16:00:00-05:00', expected_delivery_from: '2026-01-23T12:00:00-05:00',
      service_name: 'Economy', weight_kg: 23.587,
    });
    expect(result).not.toHaveProperty('delivered_at');
    // An event recorded by phone has no place; a Pacific place under an Eastern offset keeps its wall clock.
    expect(events(result)).toEqual([
      ['2026-01-21T09:30:00', 'Appointment Scheduled', null, null, 'APT'],
      ['2026-01-21T04:10:22-05:00', 'Departed Maersk Net Hub', 'in_transit', 'Hubville, OH', 'DNH'],
      ['2026-01-20T22:45:09-05:00', 'Received At Maersk Net Hub', 'in_transit', 'Hubville, OH', 'RNH'],
      ['2026-01-20T16:00:00', 'Picked Up', 'accepted', 'Sample Park, CA', 'PU'],
      ['2026-01-19T18:30:00', 'Shipment Information Sent To Maersk', 'registered', 'Sample Park, CA', 'NEW'],
    ]);
  });

  it('reads the estimate as days where the consignee’s state does not settle the offset, and leaves other appointments out', () => {
    const due = (change: (info: Info) => void) => {
      const result = parsePilot(transit(change), IN_TRANSIT);
      return [result.expected_delivery, result.expected_delivery_from ?? null];
    };
    expect(due((info) => { info.PackageConsignee.StateProvince = 'FL'; })).toEqual(['2026-01-23', null]);
    expect(due((info) => { info.PackageConsignee.StateProvince = ''; info.PackageConsignee.CountryCode = ''; })).toEqual(['2026-01-23', null]);
    expect(due((info) => { info.PackageConsignee.StateProvince = 'IL'; })).toEqual(['2026-01-23', null]);
    expect(due((info) => { info.PackageConsignee.StateProvince = 'FL'; info.AppointmentStartDate = '2026-01-22T08:00:00-05:00'; }))
      .toEqual(['2026-01-23', '2026-01-22']);
    // An appointment that ends at another time is not the delivery's, such as a pickup's.
    expect(due((info) => { info.AppointmentEndDate = '2026-01-20T19:00:00-05:00'; info.AppointmentStartDate = '2026-01-20T13:00:00-05:00'; }))
      .toEqual(['2026-01-23T16:00:00-05:00', null]);
    expect(due((info) => { info.AppointmentStartDate = '0001-01-01T00:00:00-05:00'; info.AppointmentEndDate = '0001-01-01T00:00:00-05:00'; }))
      .toEqual(['2026-01-23T16:00:00-05:00', null]);
    expect(due((info) => { info.EstimateDelvDate = '0001-01-01T00:00:00'; })).toEqual([null, null]);
    // A summer offset in winter is no clock New York keeps then.
    expect(due((info) => { info.EstimateDelvDate = '2026-01-23T16:00:00-04:00'; info.AppointmentEndDate = '2026-01-23T16:00:00-04:00'; }))
      .toEqual(['2026-01-23', null]);
  });

  it('settles a delivery whatever is recorded after it, and stages exceptions the codes leave unnamed', () => {
    const newest = (...rows: Row[]) => parsePilot(transit((info) => { info.TrackingEventHistory.unshift(...rows); }), IN_TRANSIT);
    const after = newest(row('PRE', 'PRE-CALL', '2026-01-23T18:00:00-05:00', 'HD'), row('DEL', 'DELIVERED', '2026-01-23T15:10:00-05:00'));
    expect(after).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Pre-call', expected_delivery: null,
      delivered_at: '2026-01-23T15:10:00-05:00', last_update: '2026-01-23T18:00:00-05:00' });
    expect(after).not.toHaveProperty('expected_delivery_from');
    expect(newest(row('EXC1', 'NOT HOME UPON DELIVERY', '2026-01-23T15:10:00-05:00', 'EXC')))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(newest(row('EXC21', 'BAD PHONE NUMBER', '2026-01-21T10:00:00-05:00', 'EXC'))).toMatchObject({ current_stage: 'exception' });
    // A code the table does not list: its exception type, else the shared wording rules, else nothing.
    expect(newest(row('EXC99', 'SAMPLE NEW PROBLEM', '2026-01-21T10:00:00-05:00', 'EXC')).events![0])
      .toMatchObject({ stage: 'exception', stage_source: 'carrier_map' });
    expect(newest(row('ZZZ', 'OUT FOR DELIVERY', '2026-01-21T10:00:00-05:00')).events![0])
      .toMatchObject({ stage: 'out_for_delivery', stage_source: 'wording:language' });
    expect(newest(row('ZZZ', 'SAMPLE NOTE', '2026-01-21T10:00:00-05:00')).events![0]).not.toHaveProperty('stage');
    // A delivery in a state split between zones has no instant, so it has no delivery time.
    const split = parsePilot(changed('delivered', (info) => {
      (info.TrackingEventHistory[0]!.EventLocation as Row).StateProvince = 'KY';
    }), DELIVERED);
    expect(split).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-07-09T14:05:00' });
    expect(split).not.toHaveProperty('delivered_at');
    // A place outside the US names its country and keeps its wall clock.
    const abroad = parsePilot(transit((info) => {
      info.TrackingEventHistory[1]!.EventLocation = { City: 'SAMPLE HARBOUR', StateProvince: 'ON', PostalCode: 'A1A 1A1', CountryCode: 'CA' };
    }), IN_TRANSIT);
    expect(abroad.events![1]).toMatchObject({ local_time: '2026-01-21T04:10:22', location: 'Sample Harbour, ON, CA' });
  });

  it('reads the unknown answer as not found, and a reply only when it names the pro number asked', () => {
    expect(() => parsePilot(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePilot(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'Pilot answered for another shipment' }));
    // An empty shipment without the unknown answer, or beside another shipment, says nothing.
    expect(() => parsePilot(changed('not-found', (_info, body) => { body.TrackingResponse[0]!.TrackingErrorInfo.TrackingErrorDetail = null; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pilot answered without a shipment' }));
    const both = fixture('not-found');
    both.TrackingResponse.push(fixture('delivered').TrackingResponse[0]!);
    expect(() => parsePilot(both, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePilot(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    // A known pro number without events is not an unknown one.
    expect(() => parsePilot(transit((info) => { info.TrackingEventHistory = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePilot(transit((info) => { (info as Row).TrackingEventHistory = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (info: Info) => { delete (info as Row).TrackingNumber; },
      (info: Info) => { (info as Row).TrackingNumber = 987654321; },
      (info: Info) => { (info as Row).TrackingEventHistory = 'none'; },
      (info: Info) => { info.TrackingEventHistory[0] = 'event' as never; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventCode = ''; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventCodeDesc = 7; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventLocation = 'HUBVILLE, OH'; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventDateTime = '01/21/2026 9:30 AM'; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventDateTime = '2026-01-21T24:00:00-05:00'; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventDateTime = '2026-02-30T08:00:00-05:00'; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventDateTime = '0001-01-01T00:00:00'; },
      (info: Info) => { info.TrackingEventHistory[0]!.EventDateTime = null; },
      (info: Info) => { info.EstimateDelvDate = 'soon'; },
      (info: Info) => { info.LineItemList[0]!.WeightLbs = '52'; },
      (info: Info) => { info.LineItemList[0]!.WeightLbs = -1; },
      (info: Info) => { (info as Row).LineItemList = { WeightLbs: 52 }; },
      (info: Info) => { (info as Row).PackageConsignee = 'NY'; },
      (info: Info) => { info.TrackingEventHistory = Array.from({ length: 501 }, () => info.TrackingEventHistory[0]!); },
    ]) {
      expect(() => parsePilot(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { TrackingResponse: [] }, { TrackingResponse: [{}] }, { TrackingResponse: {} }]) {
      expect(() => parsePilot(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown pro number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://delivers.maersk.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // A server's error page in place of the reply is a changed route, not a missing shipment.
    await expect(lookup('<!DOCTYPE html><html><head><title>Runtime Error</title></head><body>Server Error</body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ Message: 'An error has occurred.' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ Message: 'Synthetic failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known pro number and the unknown answer, and asks nothing for another shape', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-09T18:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects what is not a whole pro number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Short and partial numbers open other people's shipments, so only nine digits are sent.
    for (const number of ['12345', '12345678', '1234567890', '12345678A', 'ABCDEFGHI', '123/45678', `${'1'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [typed, number] of [[' 123-456-780 ', DELIVERED], ['987 654 321', IN_TRANSIT]]) {
      expect(normalizePilotNumber(typed!), typed).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('routes a pro number the caller names Pilot’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pilot-freight' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pilot-freight', source: 'pilot-freight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pilotLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Pilot Freight Services numbers', () => {
  it('leaves bare nine digits out of recognition, and reads tracker links', () => {
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('pilot-freight');
    for (const link of [`https://delivers.maersk.com/tracking/${DELIVERED}`, `https://www.pilotdelivers.com/quicktrack.aspx?Pro=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'pilot-freight', source: 'link' });
    }
  });
});

describe('Pilot Freight Services status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the codes it leaves unstaged', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(pilotStage(entry.code, 'GEN', entry.wording), entry.code)
        .toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      if (entry.unmapped) expect(statusMap.gaps.map((gap) => gap.code), entry.code).toContain(entry.code);
    }
    expect(statusMapAnswer({ carrier: 'pilot-freight', providerCode: 'DEL', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'pilot-freight', providerCode: 'APT', description: 'Appointment Scheduled' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'pilot-freight', providerCode: 'ZZZ', description: 'sample note' })).toEqual({ kind: 'unknown' });
  });
});
