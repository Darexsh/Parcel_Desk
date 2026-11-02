import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JUMPPOINT_API, JumppointTracker, jumppointLookupUrl } from './adapter.js';
import { normalizeJumppointNumber, parseJumppoint } from './parser.js';
import { jumppointLabel, jumppointStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JP000000000101';
const IN_TRANSIT = 'JP000000000202';
const CREATED = 'JP000000000303';
const UNKNOWN = 'JP000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { statusLogs: Row[] };
type Reply = Row & { data: { trackings: Shipment[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.trackings[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CAPTCHA = { success: false, data: {}, error: { error_type: 'RECAPTCHA_ERROR', user_message: 'RESPONSE_TOKEN_MISSING' } };

describe('Jumppoint HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number once, without a reCAPTCHA token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JumppointTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jp 0000-0000-0202 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JUMPPOINT_API}?trackingNumbers%5B%5D=${IN_TRANSIT}`);
    expect(String(url)).not.toContain('captcha');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jumppoint', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(jumppointLookupUrl('jp000000000101')).toBe(`${JUMPPOINT_API}?trackingNumbers%5B%5D=${DELIVERED}`);
  });

  it('reads the delivery on Hong Kong’s clock without the courier, the merchant’s reference or who signed', () => {
    const result = parseJumppoint(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Completed', last_update: '2026-05-06T14:48:09+08:00', delivered_at: '2026-05-06T14:48:09+08:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-05-06T14:48:09+08:00', 'COMPLETED', 'delivered', 'Completed'],
      ['2026-05-06T10:05:44+08:00', 'ON_THE_WAY_TO_CUSTOMER', 'out_for_delivery', 'On the Way To Customer'],
      ['2026-05-05T18:20:00+08:00', 'SCHEDULED_FOR_REDELIVER', 'failed_attempt', 'Scheduled for Redelivery'],
      ['2026-05-05T17:55:31+08:00', 'UNDELIVERED', 'failed_attempt', 'Undelivered: Nobody answer the door'],
      ['2026-05-05T10:40:08+08:00', 'ON_THE_WAY_TO_CUSTOMER', 'out_for_delivery', 'On the Way To Customer'],
      ['2026-05-05T10:40:07+08:00', 'PASSED_TO_COURIER', 'out_for_delivery', 'Passed to Courier'],
      // A confirmation moves nothing.
      ['2026-05-05T09:15:20+08:00', 'CONFIRMED', null, 'Confirmed'],
      // The repeated warehouse row is kept once.
      ['2026-05-04T21:02:45+08:00', 'ARRIVED_AT_WAREHOUSE', 'in_transit', 'Arrived At Warehouse'],
      ['2026-05-04T17:31:12+08:00', 'ON_THE_WAY_TO_WAREHOUSE', 'accepted', 'On the Way To Warehouse'],
    ]);
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('pickup_point');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Courier|Person)|0000 ?0000|SAMPLEORDER|signed|請致電/);
  });

  it('reads a parcel on its way to a pick-up point and names the point once it waits there', () => {
    const result = parseJumppoint(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'On the Way To Pick Up Store', last_update: '2026-06-09T11:15:42+08:00', expected_delivery: '2026-06-10' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['ON_THE_WAY_TO_PICK_UP_STORE', 'in_transit'],
      ['CONFIRMED', null],
      ['ARRIVED_AT_WAREHOUSE', 'in_transit'],
      ['ON_THE_WAY_TO_WAREHOUSE', 'accepted'],
      ['SENDER_DROPPED_OFF_AT_PICK_UP_STORE', 'accepted'],
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    const waiting = parseJumppoint(changed('in-transit', (shipment) => {
      shipment.shipmentState = 'ARRIVED_AT_PICK_UP_STORE';
      shipment.statusLogs.push({ createdAt: '2026-06-09T08:00:00.000Z', status: 'ARRIVED_AT_PICK_UP_STORE' });
    }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Sample Pick-up Point\nShop 1, 1 Sample Street, Sample District' });
    const collected = parseJumppoint(changed('in-transit', (shipment) => {
      shipment.shipmentState = 'COMPLETED';
      shipment.statusLogs.push({ createdAt: '2026-06-09T08:00:00.000Z', status: 'ARRIVED_AT_PICK_UP_STORE' },
        { createdAt: '2026-06-10T04:00:00.000Z', status: 'COMPLETED' });
    }), IN_TRANSIT);
    expect(collected).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-06-10T12:00:00+08:00', expected_delivery: null,
      pickup_point: 'Sample Pick-up Point\nShop 1, 1 Sample Street, Sample District' });
    expect(JSON.stringify(collected)).not.toMatch(/00000000|SAMPLESTORE|monday/);
  });

  it('reads a waybill without a status log as a summary dated when it was created', () => {
    expect(parseJumppoint(fixture('created'), CREATED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Created', provider_code: 'CREATED', summary_only: true,
      last_update: '2026-07-01T13:30:15+08:00', expected_delivery: null, events: [] });
    // Another state without a log has no date of its own.
    expect(parseJumppoint(changed('created', (shipment) => { shipment.shipmentState = 'CANCELLED'; }), CREATED))
      .toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Cancelled', last_update: null, summary_only: true });
  });

  it('heads the shipment with its state, else with its newest staged row', () => {
    // A confirmation after the warehouse leaves the parcel in transit.
    expect(parseJumppoint(changed('in-transit', (shipment) => {
      shipment.shipmentState = 'CONFIRMED';
      shipment.statusLogs.pop();
    }), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Confirmed' });
    // A same-day waybill confirmed before any courier has it is registered.
    expect(parseJumppoint(changed('created', (shipment) => {
      shipment.shipmentState = 'CONFIRMED';
      shipment.statusLogs = [{ createdAt: '2026-07-01T06:00:00.000Z', status: 'CONFIRMED' }];
    }), CREATED)).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: '2026-07-01T14:00:00+08:00' });
    // A state the tracker has no label for is spelled out from its code and staged by the wording rules.
    const unknown = parseJumppoint(changed('in-transit', (shipment) => {
      shipment.shipmentState = 'SAMPLE_NEW_STATE';
      shipment.statusLogs.push({ createdAt: '2026-06-09T08:00:00.000Z', status: 'SAMPLE_NEW_STATE' });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample new state' });
    expect(unknown.events![0]).toEqual({ time: '2026-06-09T16:00:00+08:00', description: 'Sample new state', provider_code: 'SAMPLE_NEW_STATE' });
  });

  it('reads an unknown number as not found and a reply for another number as inconclusive', () => {
    expect(() => parseJumppoint(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJumppoint(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jumppoint answered for another shipment' }));
    // The tracker echoes the number as it was sent.
    expect(parseJumppoint(changed('delivered', (shipment) => { shipment.trackingNumber = DELIVERED.toLowerCase(); }), DELIVERED).events)
      .toHaveLength(9);
    expect(() => parseJumppoint({ success: false, data: {}, error: { user_message: 'SAMPLE' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).success; },
      (_shipment: Shipment, body: Reply) => { body.data = 'data' as never; },
      (_shipment: Shipment, body: Reply) => { body.data.trackings = []; },
      (_shipment: Shipment, body: Reply) => { body.data.trackings = ['shipment' as never]; },
      (shipment: Shipment) => { shipment.statusLogs = 'logs' as never; },
      (shipment: Shipment) => { shipment.statusLogs = Array.from({ length: 501 }, () => shipment.statusLogs[0]!); },
      (shipment: Shipment) => { shipment.statusLogs[0] = 'row' as never; },
      (shipment: Shipment) => { shipment.statusLogs[0]!.createdAt = '2026-05-04 17:31'; },
      (shipment: Shipment) => { shipment.statusLogs[0]!.createdAt = '2026-02-30T00:00:00.000Z'; },
      (shipment: Shipment) => { delete shipment.statusLogs[0]!.status; },
      (shipment: Shipment) => { shipment.statusLogs[0]!.status = 'On the way'; },
      (shipment: Shipment) => { shipment.statusLogs[0]!.remarks = ['NOBODY_ANSWER_THE_DOOR']; },
      (shipment: Shipment) => { shipment.shipmentState = 7; },
      (shipment: Shipment) => { delete shipment.shipmentState; },
    ]) {
      expect(() => parseJumppoint(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a reCAPTCHA refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://tracking.jumppoint.io/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The page's own wording for a lookup its reCAPTCHA check did not pass.
    await expect(lookup(CAPTCHA)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CAPTCHA, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Forbidden</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Jumppoint</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The request shape the service no longer accepts.
    await expect(lookup({ success: false, error: { error_type: 'INVALID_PARAM_ERROR', user_message: 'TRACKING_NUMBER' } }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Jumppoint does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T06:48:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SAMPLEORDER0001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Jumppoint does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JP00000000001', 'JP0000000000001', 'JX000000000001', 'SAMPLEORDER0001', `JP${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJumppointNumber('jp 0000 0000 0101')).toBe(DELIVERED);
  });

  it('tries once more after a lookup that hangs, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 100 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Jumppoint, or detected as one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'jumppoint' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jumppoint', source: 'jumppoint', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jumppoint', source: 'jumppoint' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(JUMPPOINT_API))).toBe(true);
  });
});

describe('Jumppoint numbers', () => {
  it('claims JP and twelve digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, CREATED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'jumppoint', confidence: 'high' });
    }
  });
});

describe('Jumppoint status vocabulary', () => {
  it('records every state with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean; language: string }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(jumppointStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'jumppoint', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(jumppointStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      if (entry.language === 'en') expect(jumppointLabel(entry.code), entry.code).toBe(entry.wording);
    }
    expect(statusMapAnswer({ carrier: 'jumppoint', providerCode: 'COMPLETED', description: 'Completed' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'jumppoint', providerCode: 'SAMPLE_STATE', description: 'Sample state' })).toEqual({ kind: 'unknown' });
    // A state the map does not know falls to the shared wording rules.
    expect(jumppointStage('SAMPLE_DELIVERED', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(jumppointStage('SAMPLE_STATE', 'Sample state')).toBeNull();
  });
});
