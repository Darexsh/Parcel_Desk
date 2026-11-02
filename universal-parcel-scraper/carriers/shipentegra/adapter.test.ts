import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHIPENTEGRA_API, ShipentegraTracker } from './adapter.js';
import { normalizeShipentegraNumber, parseShipentegra, shipentegraWording } from './parser.js';
import { shipentegraStage, shipentegraSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '500000001';
const IN_TRANSIT = '500000002';
const PENDING = '500000003';
const UNKNOWN = '1SE000000000';
// A synthetic UPS number whose check digit holds.
const UPS = '1Z0000000000000126';

type Row = Record<string, unknown>;
type Reply = Row & { activities: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The tracker answers JSON as text/html.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const REFUSAL = { status: false, message: 'Invalid tracking_number parameter.' };

describe('ShipEntegra HTTP adapter', () => {
  it('posts the nine digits as the tracking page’s form does, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShipentegraTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1se 500-000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SHIPENTEGRA_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeInstanceOf(FormData);
    expect([...(init!.body as FormData).entries()]).toEqual([['tracking_number', IN_TRANSIT]]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipentegra', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and stages it by the tracker’s sentence', () => {
    const result = parseShipentegra(fixture('delivered'), `1SE${DELIVERED}`);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package has been delivered.', last_update: null, last_update_local: '2026-05-14T13:05:00',
      expected_delivery: null, destination_country: 'DE' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      ['2026-05-14T13:05:00', 'delivered', 'Package has been delivered.'],
      // The sentence outranks the partner's words after it.
      ['2026-05-14T08:40:00', 'out_for_delivery', 'Package is out for delivery.En Route'],
      ['2026-05-13T17:22:00', 'failed_attempt', 'Delivery was attempted, but was unsuccessful.Delivery failed ( no answer, call )'],
      ['2026-05-13T09:15:00', 'out_for_delivery', 'Package is out for delivery.En Route'],
      // The repeated sorting scan is kept once.
      ['2026-05-12T22:48:00', 'in_transit', 'Package is sorted, waiting for delivery.'],
      ['2026-05-12T06:30:00', 'in_transit', 'Package is arrived post office/facility.'],
      ['2026-05-11T14:02:00', 'in_transit', 'Import custom is completed.'],
      ['2026-05-10T09:41:00', 'customs', 'Import custom is started.'],
      ['2026-05-10T03:55:00', 'in_transit', 'Shipment arrived to destination facility.'],
      ['2026-05-09T21:10:00', 'in_transit', 'Flight departed'],
      ['2026-05-09T15:44:00', 'in_transit', 'Shipment customs clearance is completed. Waiting for flight.'],
      ['2026-05-09T15:30:00', 'in_transit', 'Shipment manifested'],
      ['2026-05-09T15:12:00', 'customs', 'Shipment customs clearance is started.'],
      ['2026-05-08T20:02:00', 'in_transit', 'Shipment is accepted. TR custom not cleared.'],
      ['2026-05-06T09:45:00', 'in_transit', 'PROCESSING'],
      ['2026-05-06T09:20:00', 'accepted', 'Package Received at ShipEntegra Distribution Center'],
      ['2026-05-05T16:08:00', 'registered', 'ShipEntegra Currently Awaiting Shipment and Tracking Will Be Updated When Received'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps neither the signer, a phone number, the seller’s account nor the summary’s delivery date', () => {
    const result = parseShipentegra(fixture('delivered'), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|000 000 0000|10001|12:05|1778060700/);
    // Widect's tracker takes the delivering carrier's number, which the reply does not name.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('names the partner and its number for the journey on', () => {
    const result = parseShipentegra(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PROCESSING', last_update_local: '2026-04-02T11:26:00', destination_country: 'US',
      delivery_carrier: 'ups', delivery_tracking_number: UPS });
    expect(result.events).toHaveLength(3);
    const handoff = (carrierName: string, number: string) => parseShipentegra(changed('in-transit', (body) => {
      Object.assign(body, { last_mile_carrier: carrierName, last_mile_tracking_number: number });
    }), IN_TRANSIT);
    expect(handoff('USPS', `42000000${'9205590000000000000002'}`))
      .toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9205590000000000000002' });
    expect(handoff('dhl', '1000000002')).toMatchObject({ delivery_carrier: 'dhl-express', delivery_tracking_number: '1000000002' });
    // A partner the catalog does not know, a number its carrier would not issue and ShipEntegra itself name nobody.
    for (const [name, number] of [['yodel', UPS], ['directlink', UPS], ['ups', 'SMPL0001'], ['fedex', UPS], ['SE', IN_TRANSIT],
      ['ups', ''], ['', UPS]]) {
      expect(handoff(name!, number!), `${name} ${number}`).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads a parcel the seller has not handed over yet, asked by its bare digits', () => {
    const result = parseShipentegra(fixture('pending'), PENDING);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_update_local: '2026-06-20T14:02:00', destination_country: 'MX' });
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('takes the tracker’s status for a delivery, a return or an exception, and when no scan has a stage', () => {
    const status = (value: string, change: (body: Reply) => void = () => {}) => parseShipentegra(changed('in-transit', (body) => {
      body.status_description = value;
      change(body);
    }), IN_TRANSIT);
    expect(status('DELIVERED')).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(status('RETURNED')).toMatchObject({ current_stage: 'returned' });
    expect(status('SHIPMENT EXCEPTION')).toMatchObject({ status: 'exception', current_stage: 'exception' });
    // Other statuses follow the newest scan with a stage.
    expect(status('PENDING')).toMatchObject({ current_stage: 'in_transit' });
    expect(status('UNDELIVERED', (body) => { body.activities = [{ date: '2026-04-03 10:00', event: 'Synthetic note' }]; }))
      .toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'Synthetic note' });
    expect(status('', (body) => { body.activities = [{ date: '2026-04-03 10:00', event: 'Synthetic note' }]; }))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    const unknown = status('SYNTHETIC', (body) => { body.activities = [{ date: '2026-04-03 10:00', event: 'Synthetic note' }]; });
    expect(unknown.status).toBe('unknown');
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseShipentegra(changed('delivered', (body) => { body.activities.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-05-14T13:05:00', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ stage: 'registered' });
  });

  it('takes signers and phone numbers out of the wording', () => {
    expect(shipentegraWording('Package has been delivered.Signed by Sample Person')).toBe('Package has been delivered.');
    expect(shipentegraWording('Package has been delivered.Delivered to Sample Person')).toBe('Package has been delivered.');
    expect(shipentegraWording('Package has been delivered.Delivered, received by Sample Person')).toBe('Package has been delivered.Delivered');
    expect(shipentegraWording('Package has been delivered.Teslim alan: Sample Person')).toBe('Package has been delivered.');
    expect(shipentegraWording('Delivery was attempted, but was unsuccessful.Call +00 (0) 000 000 0000 back'))
      .toBe('Delivery was attempted, but was unsuccessful.Call back');
    // A date and the partner's own reason stay.
    expect(shipentegraWording('Package is out for delivery.New date 2026-05-20')).toBe('Package is out for delivery.New date 2026-05-20');
    expect(shipentegraWording('Package Received at ShipEntegra Distribution Center ')).toBe('Package Received at ShipEntegra Distribution Center');
  });

  it('reads an unknown number as not found, and a shipment without scans as no history', () => {
    expect(() => parseShipentegra(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The tracker echoes an unknown number as an integer.
    expect(() => parseShipentegra(changed('not-found', (body) => { body.tracking_number = 7; }), '000000007'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseShipentegra(changed('not-found', (body) => { delete body.status_description; body.realCarrierStatusDescription = 'NOTFOUND'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseShipentegra(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseShipentegra(changed('not-found', (body) => { body.activities = fixture('pending').activities; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShipentegra(changed('delivered', (body) => { body.activities = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseShipentegra(changed('delivered', (body) => { delete (body as Row).activities; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseShipentegra(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ShipEntegra answered for another shipment' }));
    // The tracker once echoed the number with its prefix.
    expect(parseShipentegra(changed('in-transit', (body) => { body.tracking_number = `1SE${IN_TRANSIT}`; }), IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    expect(() => parseShipentegra(REFUSAL, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseShipentegra(['reply'], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (body: Reply) => { delete body.tracking_number; },
      (body: Reply) => { body.tracking_number = { number: IN_TRANSIT }; },
      (body: Reply) => { body.status_description = ['IN TRANSIT']; },
      (body: Reply) => { body.activities = 'activities' as never; },
      (body: Reply) => { body.activities = Array.from({ length: 501 }, () => body.activities[0]!); },
      (body: Reply) => { body.activities[0] = 'scan' as never; },
      (body: Reply) => { body.activities[0]!.date = '02/04/2026 11:26'; },
      (body: Reply) => { body.activities[0]!.date = '2026-04-02 11:26:00'; },
      (body: Reply) => { body.activities[0]!.date = '2026-04-02 24:00'; },
      (body: Reply) => { body.activities[0]!.date = '2026-02-30 11:26'; },
      (body: Reply) => { delete body.activities[0]!.date; },
      (body: Reply) => { body.activities[0]!.event = ['PROCESSING']; },
      (body: Reply) => { body.activities[0]!.event = ' '; },
      (body: Reply) => { body.last_mile_carrier = { name: 'ups' }; },
    ]) {
      expect(() => parseShipentegra(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup's refusal of a number shape it does not take.
    await expect(lookup(REFUSAL, { status: 400 })).rejects.toMatchObject({ kind: 'schema', message: 'ShipEntegra refused the number' });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://track.shipentegra.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt = {}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>ShipEntegra</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: `1SE${IN_TRANSIT}` })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(`1SE${IN_TRANSIT}`)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number ShipEntegra does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(`1SE${DELIVERED}`)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-14T13:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1SE00000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers ShipEntegra does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1SE50000000', '1SE5000000011', '2SE500000001', '50000000', UPS, `1SE${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShipentegraNumber('1se 500-000-001')).toBe(DELIVERED);
    expect(normalizeShipentegraNumber(DELIVERED)).toBe(DELIVERED);
  });

  it('asks once more after a request that did not reach ShipEntegra, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const retried = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await clock.settle(expect(carrier(retried).track({ number: IN_TRANSIT })).resolves.toMatchObject({ delivery_carrier: 'ups' }));
    expect(retried).toHaveBeenCalledTimes(2);

    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(hanging).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toBeInstanceOf(UpstreamNetworkError));
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under ShipEntegra, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'shipentegra' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shipentegra', source: 'shipentegra', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: `1SE${DELIVERED}` }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shipentegra', source: 'shipentegra' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SHIPENTEGRA_API)).toBe(true);
  });
});

describe('ShipEntegra numbers', () => {
  it('claims 1SE and nine digits, and leaves the bare nine digits to the user’s choice', () => {
    expect(detectCarrierMatch(`1SE${DELIVERED}`)).toMatchObject({ carrier: 'shipentegra', confidence: 'high' });
    for (const number of [DELIVERED, '1SE50000000', '1SE5000000011']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('shipentegra');
    }
  });
});

describe('ShipEntegra status vocabulary', () => {
  it('records every scan wording and tracker status with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        // The tracker's status for the shipment, which no scan carries.
        expect(shipentegraSummaryStage(entry.code), entry.code).toBe(entry.stage);
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(shipentegraStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'shipentegra', description: 'Package is out for delivery.En Route' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'shipentegra', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules.
    expect(shipentegraStage('Delivered to the neighbour')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(shipentegraStage('Synthetic note')).toBeNull();
    // The label scan is the one word.
    expect(statusMap.stage(null, 'processing at hub')).toBeUndefined();
  });
});
