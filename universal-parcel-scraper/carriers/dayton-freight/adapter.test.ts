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
import { adapter, DAYTON_API, daytonLookupUrl, DaytonTracker } from './adapter.js';
import { normalizeDaytonNumber, parseDayton, printedPro } from './parser.js';
import { daytonStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12345679';
const IN_TRANSIT = '9000000001';
const UNKNOWN = '99000000';

type Row = Record<string, unknown>;
type Shipment = Row & { status: Row };
type Reply = { dflResults: Shipment[]; dfxResults: Shipment[]; dftResults: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
// A fixture with its one shipment changed.
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const body = fixture(name);
  change(body.dflResults[0]!);
  return body;
};
const delivered = (change: (shipment: Shipment) => void) => changed('delivered', change);
const transit = (change: (shipment: Shipment) => void) => changed('in-transit', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseDayton>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null, event.provider_code ?? null]);

describe('Dayton Freight HTTP adapter', () => {
  it('asks the tracking search’s lookup for the whole PRO once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DaytonTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000-000-001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DAYTON_API}?numbers=${IN_TRANSIT}&type=Pro`);
    expect(daytonLookupUrl('9000 000 001')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dayton-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered status and its pickup as wall clocks, without the signer, trailer or service center', () => {
    const result = parseDayton(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'delivered to destination', last_update: null, last_update_local: '2026-03-12T14:07:00',
      expected_delivery: null, summary_only: true,
      events: [
        { local_time: '2026-03-12T14:07:00', location: 'EXAMPLEVILLE, OH', description: 'delivered to destination', provider_code: 'DLV',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-10T15:42:00', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/J Sample|500001|SAMPLETON|Example PKWY|8005550100|46999|40\.12|Appointment/);
  });

  it('reads a partner’s status on a ten-digit PRO, the estimated day and the partner taking the freight on', () => {
    const result = parseDayton(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'arrived at SAMPLE HARBOR, CT', last_update: null, last_update_local: '2026-10-14T20:50:00',
      expected_delivery: '2026-10-16', delivery_carrier: 'a-duie-pyle', delivery_tracking_number: '111222333', summary_only: true });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-10-14T20:50:00', 'arrived at SAMPLE HARBOR, CT', 'in_transit', 'SAMPLE HARBOR, CT', 'DT'],
      ['2026-10-13T15:39:00', 'Picked Up', 'accepted', null, null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PYLE0001|A DUIE PYLE INC|aduiepyle\.com/);
  });

  it('reads the barcode’s zero-padded PRO as the same shipment, and names the PRO the tracker prints', async () => {
    expect(parseDayton(fixture('delivered'), `000${DELIVERED}`)).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
    expect(parseDayton(fixture('in-transit'), `0${IN_TRANSIT}`)).toMatchObject({ canonical_tracking_number: IN_TRANSIT });
    expect(printedPro('00001234567')).toBe('1234567');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: `000${DELIVERED}` })).resolves.toMatchObject({ current_stage: 'delivered' });
    // The number goes as typed: the service reads it as a number.
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${DAYTON_API}?numbers=000${DELIVERED}&type=Pro`);
  });

  it('reads the day the page gives for the delivery until it happens', () => {
    const estimate = (change: (shipment: Shipment) => void) => parseDayton(transit(change), IN_TRANSIT).expected_delivery;
    // An appointment fixes the day.
    expect(estimate((shipment) => { shipment.appointmentFrom = '2026-10-19T08:00:00'; shipment.appointmentTo = '2026-10-19T12:00:00'; }))
      .toBe('2026-10-19');
    expect(estimate((shipment) => { shipment.appointmentFrom = null; shipment.appointmentTo = null; })).toBe('2026-10-16');
    expect(estimate((shipment) => {
      shipment.appointmentFrom = null;
      shipment.appointmentTo = null;
      shipment.estimatedDeliveryDate = '0001-01-01T00:00:00';
    })).toBeNull();
    expect(estimate((shipment) => { shipment.appointmentTo = null; shipment.estimatedDeliveryDate = null; })).toBe('2026-10-16');
    // A delivery ends the estimate.
    expect(estimate((shipment) => { shipment.status.activityCode = 'SAD'; })).toBeNull();
  });

  it('reads the activity codes the page names, and the page’s in transit for any other', () => {
    const read = (code: string, activity: string, change: (shipment: Shipment) => void = () => {}) => parseDayton(transit((shipment) => {
      shipment.status.activityCode = code;
      shipment.status.activity = activity;
      change(shipment);
    }), IN_TRANSIT);
    expect(read('OFD', 'out for delivery from SMP')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(read('PUD', 'on delivery trailer')).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(read('SBR', 'skeleton billed')).toMatchObject({ current_stage: 'accepted' });
    // The status that is the pickup adds no pickup of its own.
    const picked = read('PUP', 'picked up', (shipment) => { shipment.status.time = '2026-10-13T15:39:00'; });
    expect(events(picked)).toEqual([['2026-10-13T15:39:00', 'picked up', 'accepted', 'SAMPLE HARBOR, CT', 'PUP']]);
    // A pickup still to come is no pickup.
    const dispatched = read('DSP', 'dispatched', (shipment) => { shipment.pickupDate = '2026-10-15T10:00:00'; });
    expect(dispatched).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(dispatched.events).toHaveLength(1);
    expect(events(read('AVL', 'available', (shipment) => { shipment.pickupDate = '2026-10-13T08:00:00'; }))).toHaveLength(1);
    // A pickup after the status is not shown as before it.
    expect(read('LOD', 'loaded on outbound truck from SMP', (shipment) => { shipment.pickupDate = '2026-10-15T10:00:00'; }).events)
      .toHaveLength(1);
    // A code the page does not name: the shared wording rules, else the page's in transit, the scan left unstaged.
    expect(read('XRS', 'refused by consignee')).toMatchObject({ current_stage: 'exception', status: 'exception' });
    const other = read('XYZ', 'sample note');
    expect(other).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(other.events![0]).not.toHaveProperty('stage');
  });

  it('places a status at its town, else at its service center, and keeps a status without a clock', () => {
    const at = (change: (status: Row) => void) => parseDayton(delivered((shipment) => change(shipment.status)), DELIVERED);
    expect(at((status) => { status.city = ''; status.state = null; }).events![0]!.location).toBe('SAMPLETON, IN');
    expect(at((status) => { status.city = null; status.state = null; (status.serviceCenter as Row).id = ''; }).events![0])
      .not.toHaveProperty('location');
    expect(at((status) => { status.city = '12 SAMPLE ST'; }).events![0]!.location).toBe('OH');
    const unclocked = at((status) => { status.time = '0001-01-01T00:00:00'; });
    expect(unclocked).toMatchObject({ current_stage: 'delivered', last_status_text: 'delivered to destination', last_update: null });
    // The pickup does not date the status.
    expect(unclocked).not.toHaveProperty('last_update_local');
    expect(events(unclocked)).toEqual([['2026-03-10T15:42:00', 'Picked Up', 'accepted', null, null]]);
  });

  it('adds the border crossing, and a partner’s pickup day for freight a partner collected', () => {
    const result = parseDayton(transit((shipment) => {
      shipment.status.arrivedAtBorder = '2026-10-14T06:10:00';
      shipment.status.clearedCustoms = '2026-10-14T09:25:00';
      shipment.originPartner = { pro: 'SAMPLE1', code: 'MANI', name: 'SAMPLE PARTNER', pickupDate: '2026-10-12T00:00:00' };
    }), IN_TRANSIT);
    expect(events(result)).toEqual([
      ['2026-10-14T20:50:00', 'arrived at SAMPLE HARBOR, CT', 'in_transit', 'SAMPLE HARBOR, CT', 'DT'],
      ['2026-10-14T09:25:00', 'Cleared Customs', 'in_transit', null, null],
      ['2026-10-14T06:10:00', 'Arrived at Border', 'customs', null, null],
      ['2026-10-12', 'Picked Up', 'accepted', null, null],
    ]);
  });

  it('reads a summary without a status from its pickup', () => {
    const result = parseDayton(transit((shipment) => { shipment.status = null as never; }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Picked Up' });
    expect(() => parseDayton(transit((shipment) => { shipment.status = null as never; shipment.pickupDate = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('names only the partners the page names, with their PRO, and not Dayton Freight’s own services', () => {
    const partner = (code: unknown, pro: unknown) => {
      const { delivery_carrier, delivery_tracking_number } = parseDayton(transit((shipment) => {
        shipment.destinationPartner = { ...(shipment.destinationPartner as Row), code, pro };
      }), IN_TRANSIT);
      return [delivery_carrier ?? null, delivery_tracking_number ?? null];
    };
    expect(partner('SEFL', '123-456-789')).toEqual(['southeastern-freight-lines', '123456789']);
    expect(partner('oakh', 12345679)).toEqual(['oak-harbor', '12345679']);
    expect(partner('DFXP', IN_TRANSIT)).toEqual([null, null]);
    expect(partner('MANI', 'SAMPLE1')).toEqual([null, null]);
    expect(partner('PYLE', '')).toEqual([null, null]);
    expect(partner('PYLE', '12#45678')).toEqual([null, null]);
    expect(parseDayton(transit((shipment) => { shipment.destinationPartner = null; }), IN_TRANSIT)).not.toHaveProperty('delivery_carrier');
  });

  it('reads every list empty as not found, and a shipment only when its PRO is the number asked', () => {
    expect(() => parseDayton(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDayton(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'Dayton Freight answered for another shipment' }));
    // An expedited or truckload result counts like a freight one.
    const body = fixture('in-transit');
    const expedited = { dflResults: [], dfxResults: body.dflResults, dftResults: [] };
    expect(parseDayton(expedited, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    const both = { ...fixture('delivered'), dftResults: body.dflResults };
    expect(parseDayton(both, IN_TRANSIT)).toMatchObject({ last_status_text: 'arrived at SAMPLE HARBOR, CT' });
    expect(parseDayton(transit((shipment) => { shipment.pro = ` 0${IN_TRANSIT} `; }), IN_TRANSIT).events).toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.pro; },
      (shipment: Shipment) => { shipment.pro = 9.5; },
      (shipment: Shipment) => { shipment.pro = 'PRO-1'; },
      (shipment: Shipment) => { shipment.status = 'delivered' as never; },
      (shipment: Shipment) => { shipment.status.activity = ['arrived']; },
      (shipment: Shipment) => { shipment.status.activityCode = 7; },
      (shipment: Shipment) => { shipment.status.city = { name: 'SAMPLE' }; },
      (shipment: Shipment) => { shipment.status.time = '10/14/2026 8:50 PM'; },
      (shipment: Shipment) => { shipment.status.time = '2026-10-14T24:00:00'; },
      (shipment: Shipment) => { shipment.status.time = '2026-02-30T08:00:00'; },
      (shipment: Shipment) => { shipment.status.time = '2026-10-14T20:50:00-04:00'; },
      (shipment: Shipment) => { shipment.status.time = 1_792_000_000_000; },
      (shipment: Shipment) => { shipment.pickupDate = '2026-10-13'; },
      (shipment: Shipment) => { shipment.estimatedDeliveryDate = '10/16/2026'; shipment.appointmentFrom = null; shipment.appointmentTo = null; },
      (shipment: Shipment) => { shipment.destinationPartner = 'PYLE'; },
      (shipment: Shipment) => { shipment.destinationPartner = { code: 'PYLE', pro: ['111222333'] }; },
    ]) {
      expect(() => parseDayton(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const row = fixture('in-transit').dflResults[0];
    for (const body of ['reply', null, [], {}, { dflResults: [], dfxResults: [] }, { dflResults: 'none', dfxResults: [], dftResults: [] },
      { dflResults: ['shipment'], dfxResults: [], dftResults: [] },
      { dflResults: Array.from({ length: 26 }, () => row), dfxResults: [], dftResults: [] }]) {
      expect(() => parseDayton(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown PRO, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>Dayton Freight - Page Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tools.daytonfreight.com/account/login' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Dayton Freight - Shipment Tracking</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ Message: 'An error has occurred.' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ Message: 'Synthetic failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known PRO and the empty answer, and asks nothing for a number Dayton Freight does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:07:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('123456')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Dayton Freight does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456', '0123456', '12345678901', '000000000000', 'ABCDEFGH', '1234567X', `12345679${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['1234567', '12345679', '123456789', '1234567890', '00001234567', '01234567890']) {
      expect(normalizeDaytonNumber(number), number).toBe(number);
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

  it('routes a PRO the caller names Dayton Freight’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dayton-freight' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dayton-freight', source: 'dayton-freight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === daytonLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Dayton Freight numbers', () => {
  it('leaves PROs to the caller’s choice, and reads tracker links', () => {
    // Many carriers issue these lengths, so neither detection nor recognition offers Dayton Freight.
    for (const number of [DELIVERED, IN_TRANSIT, `000${DELIVERED}`]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('dayton-freight');
      expect(recognitionAskedCarriers(number), number).not.toContain('dayton-freight');
    }
    for (const link of [`https://tools.daytonfreight.com/tracking/detail/${DELIVERED}`,
      `https://tools.daytonfreight.com/tracking/detail?id=${DELIVERED}`,
      `https://www.daytonfreight.com/scripts/statusdetail.asp?pro=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'dayton-freight', source: 'link' });
    }
  });
});

describe('Dayton Freight status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(daytonStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'dayton-freight', providerCode: 'DLV', description: 'delivered to destination' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'dayton-freight', providerCode: 'SBR', description: 'sample' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'dayton-freight', providerCode: 'XYZ', description: 'sample note' })).toEqual({ kind: 'unknown' });
    // A code decides over its wording.
    expect(statusMap.stage('DLV', 'arrived at destination terminal.')).toBe('delivered');
    expect(daytonStage('', 'SAMPLE NOTE')).toBeNull();
    // Wording the map does not know falls to the shared rules.
    expect(daytonStage('', 'arrived at 12 SAMPLE ST')).toEqual({ stage: 'in_transit', source: 'wording:language' });
  });
});
