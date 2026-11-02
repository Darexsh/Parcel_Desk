import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { isValidS10TrackingNumber } from '../../core/detection/index.js';
import { fetchSunYou, parseSunYouTrackingResponse, SunYouTracker } from './adapter.js';

const folder = path.dirname(fileURLToPath(import.meta.url));
const carrier = JSON.parse(
  readFileSync(path.join(folder, 'carrier.json'), 'utf8'),
) as { capabilities: string[] };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(folder, 'fixtures', name), 'utf8'));
}

const SUNYOU_WRONG_NUMBER = 'SY00000000000';

/** The endpoint answers JSONP, not JSON. */
function jsonpResponse(payload: unknown): Response {
  return new Response(`searchCallback(${JSON.stringify(payload)})`);
}

afterEach(() => vi.restoreAllMocks());

describe('SunYou wrong-number handling', () => {
  it('maps the official not-found status to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonpResponse({
      data: [{
        displayStatus: '0',
        has: true,
        orderNo: SUNYOU_WRONG_NUMBER,
        privateMessage: 'Private upstream details',
      }],
      message: 'success',
      status: 1,
    }));

    try {
      await fetchSunYou(SUNYOU_WRONG_NUMBER);
      throw new Error('Expected the lookup to fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'NotFoundError', status: 404, kind: 'not_found' });
      expect(String(error)).toContain('SunYou could not locate the shipment');
      expect(String(error)).not.toContain('Private upstream details');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get('trackNumber')).toBe(SUNYOU_WRONG_NUMBER);
  });

  it('keeps an outage or challenge page retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<html><title>Service unavailable</title></html>',
    ));

    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER))
      .rejects.toThrow('SunYou returned an invalid tracking response');
  });

  it('rejects an answer describing a different shipment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'searchCallback({"data":[{"orderNo":"SY11111111111","has":false}]})',
    ));

    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER)).rejects.toThrow('different shipment');
  });

  it('uses the environment fetcher the factory hands the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonpResponse({
      data: [{ orderNo: SUNYOU_WRONG_NUMBER, displayStatus: '1', has: true }],
    }));
    const global = vi.spyOn(globalThis, 'fetch');

    await expect(new SunYouTracker({ fetcher }).fetch(SUNYOU_WRONG_NUMBER))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('official SunYou display statuses', () => {
  it('accepts numeric status codes without treating an array as a code', () => {
    const payload = (displayStatus: unknown) => ({ data: [{ orderNo: SUNYOU_WRONG_NUMBER, has: true, displayStatus }] });
    expect(parseSunYouTrackingResponse(payload(4), SUNYOU_WRONG_NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    for (const value of [['4'], { value: '4' }]) {
      const result = parseSunYouTrackingResponse(payload(value), SUNYOU_WRONG_NUMBER);
      expect(result.status).toBe('in_transit');
      expect(result.current_stage).toBeUndefined();
    }
  });

  it.each([
    ['1', 'in_transit', 'in_transit'],
    ['2', 'out_for_delivery', 'ready_for_pickup'],
    ['3', 'exception', 'failed_attempt'],
    ['4', 'delivered', 'delivered'],
    ['5', 'exception', 'failed_attempt'],
    ['6', 'exception', 'failed_attempt'],
  ] as const)('maps displayStatus %s to %s / %s', async (displayStatus, status, stage) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonpResponse({
      data: [{
        displayStatus,
        has: true,
        orderNo: SUNYOU_WRONG_NUMBER,
        result: {
          origin: {
            items: [{ createTime: '2026-08-30T12:00:00Z', content: 'Latest event' }],
          },
        },
      }],
    }));

    await expect(fetchSunYou(SUNYOU_WRONG_NUMBER)).resolves.toMatchObject({
      status,
      current_stage: stage,
      events: [{ stage }],
    });
  });
});

describe('SunYou event timezones', () => {
  function sunYouResponse(origin: unknown[], destination: unknown[]) {
    return jsonpResponse({
      data: [{
        displayStatus: '4',
        has: true,
        orderNo: SUNYOU_WRONG_NUMBER,
        result: { origin: { items: origin }, destination: { items: destination } },
      }],
    });
  }

  it('honors per-leg offsets and orders by instant rather than wall-clock string', async () => {
    // Observed on a captured SYAE shipment: origin scans carry "+08:00" while
    // the wall-clock strings would sort the other way round.
    // Source: https://github.com/ha-parcel-integrations/ha-sunyou/blob/main/tests/payloads.py
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sunYouResponse(
      [{ createTime: '2021-07-06 01:43:13', timeZone: '+08:00', content: 'Origin scan' }],
      [{ createTime: '2021-07-05 20:00:00', timeZone: '+02:00', content: 'Destination scan' }],
    ));

    const result = await fetchSunYou(SUNYOU_WRONG_NUMBER);
    expect(result.events?.map((event) => [event.description, event.time])).toEqual([
      ['Destination scan', '2021-07-05T20:00:00+02:00'],
      ['Origin scan', '2021-07-06T01:43:13+08:00'],
    ]);
  });

  it('keeps scans of one instant in the carrier\'s order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sunYouResponse(
      [{ createTime: '2021-07-06 01:43:13', timeZone: '+08:00', content: 'Origin scan' }],
      [{ createTime: '2021-07-08 09:00:00', timeZone: '+02:00', content: 'Arrived' }, { createTime: '2021-07-08 09:00:00', timeZone: '+02:00', content: 'Sorted' }],
    ));

    const result = await fetchSunYou(SUNYOU_WRONG_NUMBER);
    expect(result.events?.map((event) => event.description)).toEqual(['Sorted', 'Arrived', 'Origin scan']);
  });

  it('keeps provider text when no usable offset exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sunYouResponse(
      [
        { createTime: '2021-07-06 01:43:13', content: 'No zone' },
        { createTime: '2021-07-06 01:44:13', timeZone: 'Mars', content: 'Bad zone' },
        { createTime: '2021-07-07T01:45:13+08:00', timeZone: '+02:00', content: 'Already offset' },
      ],
      [],
    ));

    const result = await fetchSunYou(SUNYOU_WRONG_NUMBER);
    expect(result.events?.map((event) => event.time)).toEqual([
      '2021-07-07T01:45:13+08:00',
      '2021-07-06 01:44:13',
      '2021-07-06 01:43:13',
    ]);
  });
});

describe('SunYou declared capabilities and privacy', () => {
  const delivered = parseSunYouTrackingResponse(fixture('delivered.json'), 'SYAE100000001');
  const coded = parseSunYouTrackingResponse(fixture('coded.json'), 'SYGB000000001');
  const checks: Record<string, (result: CarrierResult) => boolean> = {
    history: (result) => (result.events?.length ?? 0) > 0,
    location: (result) => (result.events ?? []).some((event) => Boolean(event.location)),
    eta: (result) => Boolean(result.expected_delivery),
    eta_window: (result) => Boolean(result.expected_delivery_from),
    sender_name: (result) => Boolean(result.sender_name),
    pickup_point: (result) => Boolean(result.pickup_point),
    weight: (result) => result.weight_kg != null,
    dimensions: (result) => Boolean(result.dimensions_text),
    delivered_at: (result) => Boolean(result.delivered_at),
    provider_code: (result) => (result.events ?? []).some((event) => Boolean(event.provider_code)),
    delivery_partner: (result) => Boolean(result.delivery_carrier),
    delivery_tracking_number: (result) => Boolean(result.delivery_tracking_number),
  };

  it('merges both legs into one journey ordered by absolute instant', () => {
    expect(delivered).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-09-03T11:20:00+02:00',
      expected_delivery: null,
    });
    expect(delivered.events?.map((event) => [event.description, event.time])).toEqual([
      ['Delivered', '2026-09-03T11:20:00+02:00'],
      ['Arrived at the destination facility', '2026-09-02T07:15:00+02:00'],
      ['Departed from the origin facility', '2026-08-29T21:40:00+08:00'],
      ['Shipment picked up', '2026-08-28T09:10:00+08:00'],
    ]);
    // Only the newest scan inherits the shipment-level stage.
    expect(delivered.events?.map((event) => event.stage)).toEqual([
      'delivered', undefined, undefined, undefined,
    ]);
  });

  it("leaves the last-mile number out of the departure's wording; the hand-off carries it", () => {
    expect(coded.events?.find((event) => event.provider_code === 'Dispatch')?.description).toBe('Departed Sunyou Facility');
    expect(coded.delivery_tracking_number).toBe('ZZ000000005GB');
  });

  it.each(carrier.capabilities)('declares %s and a fixture proves it', (capability) => {
    const check = checks[capability];
    expect(check, `unknown capability ${capability}`).toBeTypeOf('function');
    expect(check!(coded)).toBe(true);
  });

  it('drops the recipient and the signature', () => {
    const projected = JSON.stringify([delivered, coded]);
    for (const value of ['Made Up Recipient', 'Example Street 1', 'proof-of-delivery']) {
      expect(projected).not.toContain(value);
    }
  });
});

describe('SunYou scan codes and last-mile handoff', () => {
  const coded = fixture('coded.json') as { data: [Record<string, unknown>] };
  const withItem = (changes: Record<string, unknown>) => ({ data: [{ ...coded.data[0], ...changes }] });
  const scan = (eventCode: string, content: string) => ({
    result: { origin: { items: [{ createTime: '2026-08-15 22:41:52', timeZone: '+01:00', eventCode, content }] } },
  });

  it('stages every scan by its own code and keeps the code', () => {
    const result = parseSunYouTrackingResponse(coded, 'SYGB000000001');
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['Delivered_Doorstep', 'delivered'],
      ['OutForDelivery', 'out_for_delivery'],
      ['ClearanceSuccessed', 'in_transit'],
      ['ClearanceProcess', 'customs'],
      ['Dispatch', 'in_transit'],
      ['InboundScan', 'accepted'],
      ['PreAlert', 'registered'],
    ]);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      delivered_at: '2026-08-19T12:26:09+01:00',
      destination_country: 'GB',
      delivery_carrier: 'royal-mail',
      delivery_tracking_number: 'ZZ000000005GB',
    });
  });

  it('lets the newest scan code refine the generic in-transit display status', () => {
    const result = parseSunYouTrackingResponse(
      withItem({ displayStatus: '1', ...scan('ClearanceProcess', 'Customs Clearance In Process') }),
      'SYGB000000001',
    );
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', events: [{ stage: 'customs' }] });
    expect(result.delivered_at).toBeUndefined();
  });

  it('falls back to the display status for a code it does not know', () => {
    const result = parseSunYouTrackingResponse(
      withItem({ displayStatus: '3', ...scan('SomethingNew', 'Delivery attempt failed') }),
      'SYGB000000001',
    );
    expect(result).toMatchObject({
      status: 'exception',
      current_stage: 'failed_attempt',
      events: [{ provider_code: 'SomethingNew', stage: 'failed_attempt' }],
    });
  });

  it('names no export post: the hand-off goes by destination', () => {
    // SunYou names China Post, with its own postal number, for a parcel to Japan.
    const reference = 'LP000000005CN';
    expect(isValidS10TrackingNumber(reference)).toBe(true);
    const result = parseSunYouTrackingResponse(withItem({
      dstCountry: 'JP', carrierName: 'China Post', carrierWebsite: 'https://www.ems.com.cn/', trackingNumber: reference,
    }), 'SYGB000000001');
    expect(result).toMatchObject({ destination_country: 'JP', delivery_tracking_number: reference });
    expect(result.delivery_carrier).toBeUndefined();
    expect(deliveryHandoff('sunyou', 'SYGB000000001', result)).toEqual({ carrier: 'japan-post', number: reference, basis: 'destination' });
    // With no national post for the destination, the number's issuer takes it.
    const elsewhere = parseSunYouTrackingResponse(withItem({
      dstCountry: 'TV', carrierName: 'China Post', carrierWebsite: 'https://www.ems.com.cn/', trackingNumber: reference,
    }), 'SYGB000000001');
    expect(elsewhere.delivery_carrier).toBeUndefined();
    expect(deliveryHandoff('sunyou', 'SYGB000000001', elsewhere)).toEqual({ carrier: 'china-post', number: reference, basis: 'reference' });
  });

  it('names no carrier that does not serve the destination', () => {
    const result = parseSunYouTrackingResponse(withItem({ dstCountry: 'FR' }), 'SYGB000000001');
    expect(result.delivery_tracking_number).toBe('ZZ000000005GB');
    expect(result.delivery_carrier).toBeUndefined();
    const usps = { carrierName: 'USPS', carrierWebsite: 'https://www.usps.com/', trackingNumber: '9214490000000000000003' };
    const domestic = parseSunYouTrackingResponse(withItem({ dstCountry: 'US', ...usps }), 'SYGB000000001');
    expect(domestic.delivery_carrier).toBe('usps');
    // Not a postal number, so only the countries USPS serves keep it out of Canada.
    const abroad = parseSunYouTrackingResponse(withItem({ dstCountry: 'CA', ...usps }), 'SYGB000000001');
    expect(abroad).toMatchObject({ destination_country: 'CA', delivery_tracking_number: '9214490000000000000003' });
    expect(abroad.delivery_carrier).toBeUndefined();
    const unknown = parseSunYouTrackingResponse(withItem({ dstCountry: undefined }), 'SYGB000000001');
    expect(unknown.delivery_carrier).toBeUndefined();
  });

  it('keeps the reference but names no carrier whose detection does not offer it', () => {
    const result = parseSunYouTrackingResponse(withItem({ trackingNumber: 'AB12' }), 'SYGB000000001');
    expect(result.delivery_tracking_number).toBe('AB12');
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('reports no handoff when the reference is the shipment itself', () => {
    const result = parseSunYouTrackingResponse(withItem({ trackingNumber: 'sygb000000001' }), 'SYGB000000001');
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
  });
});

describe('SunYou stored scans', () => {
  const policy = sameInstantIdentityPolicy('sunyou', { supportsScanMatching: true });
  const stored = { stage: 'in_transit', description: 'Acceptance, Sent To Example Land', location: '', providerCode: '' };
  const incoming = { ...stored, stage: 'accepted', providerCode: 'InboundScan' };

  it('lets a scan stored before its code was kept take the code and its stage', () => {
    expect(sameInstantIdentityPolicy('sunyou')).toBeUndefined();
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, providerCode: 'InboundScan', stage: 'accepted' })).toBe(true);
  });

  it('lets the departure stored with its last-mile number take the shorter wording', () => {
    const departed = { stage: 'in_transit', location: '', providerCode: 'Dispatch', description: 'Departed Sunyou Facility, Carrier Tracking Number:  ZZ000000005GB' };
    expect(policy?.matches?.({ ...departed, description: 'Departed Sunyou Facility' }, departed)).toBe(true);
    expect(policy?.matches?.({ ...departed, description: 'Departed Sunyou Facility', providerCode: 'InboundScan' }, departed)).toBe(false);
  });

  it('keeps other scans apart', () => {
    for (const different of [
      { ...stored, providerCode: 'PreAlert' },
      { ...stored, description: 'Pre-Shipment Info Sent To Example Land' },
      { ...stored, location: 'Example City' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(false);
  });
});
