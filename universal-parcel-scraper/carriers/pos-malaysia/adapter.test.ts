import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, SchemaError, InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import {
  normalizePosMalaysiaTrackingNumber,
  parsePosMalaysiaTrackingResponse,
  posMalaysiaTrackingUrl,
  PosMalaysiaTracker,
  adapter,
} from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { classifyPosMalaysiaStatus, isMappedPosMalaysiaSummary } from './status.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// All identifiers, timestamps, offices and names below are synthetic. Event
// wordings and process summaries reuse the vendor's fixed English texts found
// in the official tracking bundle's own demo parcel, so classification
// exercises production prose rather than paraphrases.
const TRACKING_NUMBER = 'MYPM00000000015';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const INTERNATIONAL = JSON.parse(
  readFileSync(new URL('./fixtures/international.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function detail(summary: string, process: string, date: string, eventType = 'EM001', office = 'Test Hub Shah Alam') {
  return { type: 'Valid', date, process, process_summary: summary, office, error_details: null, event_type: eventType, epod: '', reason: '' };
}

function item(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function payload(items: unknown[]) {
  return { code: 'S0000', message: 'Success', data: items };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Pos Malaysia tracking normalization', () => {
  it('accepts MYPM barcodes, Pos Laju consignments and S10 identifiers and rejects the rest', () => {
    expect(normalizePosMalaysiaTrackingNumber('mypm00000000015')).toBe(TRACKING_NUMBER);
    expect(normalizePosMalaysiaTrackingNumber('RR157638464MY')).toBe('RR157638464MY');
    expect(normalizePosMalaysiaTrackingNumber('ehe 000000005 my')).toBe('EHE000000005MY');
    // Inbound postal items keep their origin's number; its check digit must pass.
    expect(normalizePosMalaysiaTrackingNumber('RR000000005BN')).toBe('RR000000005BN');
    for (const raw of ['12345', 'Z8328162951', 'MYPM000000001', '', 'RR000000006BN', 'EHEE00000005MY']) {
      expect(() => normalizePosMalaysiaTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(posMalaysiaTrackingUrl(TRACKING_NUMBER)).toBe('https://tracking.pos.com.my/tracking/MYPM00000000015');
  });
});

describe('Pos Malaysia response parsing', () => {
  it('returns delivered history newest-first with Kuala Lumpur timestamps', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([item()]), TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'We have delivered your parcel. Thank you!',
      last_update: '2026-02-23T13:40:28+08:00',
      expected_delivery: null,
      timezone: 'Asia/Kuala_Lumpur',
    });
    expect(result.events?.map((event) => [event.stage, event.time, event.location])).toEqual([
      ['delivered', '2026-02-23T13:40:28+08:00', 'Test Hub Shah Alam'],
      ['out_for_delivery', '2026-02-23T09:52:32+08:00', 'Test Hub Shah Alam'],
      ['in_transit', '2026-02-23T08:20:50+08:00', 'Test Hub Shah Alam'],
      ['in_transit', '2026-02-23T03:16:01+08:00', 'Test Hub Shah Alam'],
      ['in_transit', '2026-02-22T17:34:58+08:00', 'Test Hub Shah Alam'],
      ['accepted', '2026-02-22T10:05:10+08:00', 'Test Hub Shah Alam'],
    ]);
  });

  it('maps explicit summaries and keeps unknown or inherited names unmapped', () => {
    const cases: Array<[string, string, string]> = [
      ['Collected', 'in_transit', 'accepted'],
      ['On the way', 'in_transit', 'in_transit'],
      ['Sorting completed', 'in_transit', 'in_transit'],
      ['Preparing for delivery', 'in_transit', 'in_transit'],
      ['Out for delivery', 'out_for_delivery', 'out_for_delivery'],
      ['Delivery completed', 'delivered', 'delivered'],
      ['Item arrived at delivery office', 'in_transit', 'in_transit'],
      ['Your parcel is being transported to the next facility', 'in_transit', 'in_transit'],
      ['Your parcel has arrived at destination facility for Processing', 'in_transit', 'in_transit'],
      ['Your parcel is being transported to destination country', 'in_transit', 'in_transit'],
      ['Your parcel has arrived at our facility for sorting', 'in_transit', 'in_transit'],
    ];
    for (const [summary, status, stage] of cases) {
      expect(isMappedPosMalaysiaSummary(summary)).toBe(true);
      expect(classifyPosMalaysiaStatus(summary)).toEqual({ status, stage });
    }
    for (const label of ['Something completely new', '__proto__', 'constructor', 'toString']) {
      expect(isMappedPosMalaysiaSummary(label)).toBe(false);
      expect(classifyPosMalaysiaStatus(label)).toBeNull();
      const result = normalizeCarrierResult(parsePosMalaysiaTrackingResponse(payload([item({ process_status: '',
        tracking_data: [detail(label, 'Visible unknown scan', '23 Feb 2026, 01:40:28 PM')],
      })]), TRACKING_NUMBER));
      expect(result.status).toBe('unknown');
      expect(result).not.toHaveProperty('current_stage');
      expect(result.events?.[0]).not.toHaveProperty('stage');
      expect(result.events?.[0]?.description).toBe('Visible unknown scan');
    }
  });

  it('derives non-delivered status from the latest event', () => {
    const active = parsePosMalaysiaTrackingResponse(payload([item({
      process_status: 'IN TRANSIT',
      tracking_data: [detail('On the way', 'Moving', '22 Feb 2026, 05:34:58 PM', 'EM005')],
    })]), TRACKING_NUMBER);
    expect(active).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    const pickup = parsePosMalaysiaTrackingResponse(payload([item({
      process_status: '',
      tracking_data: [detail('Out for delivery', 'Courier', '23 Feb 2026, 09:52:32 AM', 'EM014')],
    })]), TRACKING_NUMBER);
    expect(pickup).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([item({
      process_status: 'IN TRANSIT',
      tracking_data: [
        detail('Item dispatched', 'Dispatched', '21 Feb 2026, 08:00:00 AM', 'EM003'),
        detail('Item processed', 'Processed', '22 Feb 2026, 05:34:58 PM', 'EM004'),
        detail('On the way', 'Moving', '22 Feb 2026, 05:34:58 PM', 'EM005'),
      ],
    })]), TRACKING_NUMBER);
    expect(result.events?.map((event) => event.provider_code)).toEqual(['EM005', 'EM004', 'EM003']);
  });

  it('requires one exact identity and distinguishes absent schema from empty history', () => {
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ connote_id: 'MYPM00000000017' })]), TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ connote_id: undefined })]), TRACKING_NUMBER))
      .toThrow(SchemaError);
    for (const connote_id of ['MYPM.00000000015', 'MYPM-00000000015', 'MYPM 00000000015']) {
      expect(() => parsePosMalaysiaTrackingResponse(payload([item({ connote_id })]), TRACKING_NUMBER)).toThrow(SchemaError);
    }
    expect(parsePosMalaysiaTrackingResponse(payload([item({ connote_id: ` ${TRACKING_NUMBER.toLowerCase()} ` })]), TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered' });
    for (const history of [null, []]) {
      expect(() => parsePosMalaysiaTrackingResponse(payload([item({ process_status: '', tracking_data: history })]), TRACKING_NUMBER))
        .toThrow(IndeterminateError);
      expect(parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: history })]), TRACKING_NUMBER))
        .toMatchObject({ status: 'delivered', last_update: null, events: [{ stage: 'delivered', summary_snapshot: true }] });
    }
    expect(() => parsePosMalaysiaTrackingResponse(payload([item(), item()]), TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: undefined })]), TRACKING_NUMBER)).toThrow(SchemaError);
    const omitted = item();
    delete omitted.tracking_data;
    expect(() => parsePosMalaysiaTrackingResponse(payload([omitted]), TRACKING_NUMBER)).toThrow(SchemaError);
    // An explicit delivered overall remains useful without a fabricated time.
    expect(parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: [] })]), TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', events: [{ stage: 'delivered', summary_snapshot: true }] });
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ process_status: '', tracking_data: [] })]), TRACKING_NUMBER))
      .toThrow(IndeterminateError);
    expect(() => parsePosMalaysiaTrackingResponse(payload([]), TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePosMalaysiaTrackingResponse({ code: 'E9999', data: [] }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePosMalaysiaTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
  });

  it('deduplicates the same evidence without dropping malformed clock scans', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([item({
      process_status: '',
      tracking_data: [
        detail('Delivery completed', 'Done', '23 Feb 2026, 01:40:28 PM', 'EM053'),
        detail('Delivery completed', 'Done', '23 Feb 2026, 01:40:28 PM', 'EM053'),
        detail('Delivery completed', 'Done', 'not a date', 'EM053'),
      ],
    })]), TRACKING_NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[1]).toMatchObject({ provider_time_text: 'not a date' });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('rejects malformed and Error rows rather than silently promoting older scans', () => {
    for (const scan of ['not a record', null, detail('', '', '23 Feb 2026, 01:40:28 PM'), { type: 'Unexpected' },
      { ...detail('On the way', 'Malformed clock', ''), date: 123 }]) {
      expect(() => parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: [scan,
        detail('On the way', 'Older scan', '22 Feb 2026, 05:34:58 PM')],
      })]), TRACKING_NUMBER)).toThrow(SchemaError);
    }
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: [{ type: 'Error', process: 'Try again' }] })]), TRACKING_NUMBER))
      .toThrow(IndeterminateError);
    expect(() => parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: Array.from({ length: 501 }, () => detail('On the way', 'Moving', '22 Feb 2026, 05:34:58 PM')) })]), TRACKING_NUMBER))
      .toThrow(SchemaError);
  });

  it.each(['not a date', '31 Feb 2026, 01:40:28 PM', '', undefined, null])('preserves source order and current uncertainty for clock %s', clock => {
    const result = parsePosMalaysiaTrackingResponse(payload([item({ process_status: '', tracking_data: [
      { ...detail('Out for delivery', 'Current courier scan', ''), date: clock },
      detail('On the way', 'Older scan', '22 Feb 2026, 05:34:58 PM'),
    ] })]), TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: null });
    expect(result.events?.map(event => event.description)).toEqual(['Current courier scan', 'Older scan']);
    expect(result.events?.[0]).not.toHaveProperty('time');
    if (clock) expect(result.events?.[0]?.provider_time_text).toBe(clock);
  });

  it('does not apply Malaysian time to international or unlocated scans', () => {
    for (const route of [
      { sender_data: { sender_country: 'MY' }, recipient_data: { receipient_country: 'BD' } },
      { sender_data: { sender_country: 'GB' }, recipient_data: { receipient_country: 'MY' } },
      { sender_data: null, recipient_data: null },
    ]) {
      const result = parsePosMalaysiaTrackingResponse(payload([item({ ...route, process_status: '', tracking_data: [
        detail('Item arrived at delivery office', 'Arrived at destination office', '23 Feb 2026, 01:40:28 PM', 'EMG', ''),
        detail('On the way', 'Earlier international scan', '22 Feb 2026, 05:34:58 PM', 'TN035', ''),
      ] })]), TRACKING_NUMBER);
      expect(result).toMatchObject({ status: 'in_transit', last_update: null });
      expect(result).not.toHaveProperty('timezone');
      expect(result.events?.every(event => !event.time && typeof event.provider_time_text === 'string')).toBe(true);
    }
  });

  it('keeps current international history identity-bound without guessed instants', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([INTERNATIONAL]), 'RR000000005MY');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_status_text: 'Item arrived at delivery office' });
    expect(result.events).toHaveLength(5);
    expect(result.events?.map(event => event.provider_code)).toEqual(['EMG', 'TN035', 'TN030', 'TN008', 'TN001']);
    expect(result.events?.every(event => !event.time && event.provider_time_text)).toBe(true);
  });

  it('reads an inbound item through customs to its delivery scan without a summary snapshot', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([item({ connote_id: 'RR000000005BN',
      sender_data: { sender_country: 'BN' }, recipient_data: { receipient_country: 'MY' }, process_status: 'DELIVERED', tracking_data: [
        detail('Destination station has delivered your parcel. Thank you!', 'Delivery completed', '12 Feb 2026, 02:07:41 PM', 'TN037', ''),
        detail('Your parcel is out for delivery', 'Out for delivery', '12 Feb 2026, 09:46:05 AM', 'EDG', ''),
        detail('Your parcel has been cleared by the Customs Authority', 'Customs released', '08 Feb 2026, 03:12:27 PM', 'EDC', ''),
        detail('Your parcel has been presented to the Customs Authority for inspection', 'Customs inspection', '08 Feb 2026, 10:05:52 AM', 'EDB', ''),
        detail('Arrived at International Hub', '', '04 Feb 2026, 11:35:00 AM', 'TN003', ''),
        detail('Your parcel has arrived at our facility for sorting', 'Sorting in progress', '03 Feb 2026, 08:47:00 AM', '01', 'In Transit'),
      ] })]), 'RR000000005BN');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivery completed', last_update: null });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'customs', 'in_transit', 'in_transit']);
    expect(result.events?.some(event => event.summary_snapshot)).toBe(false);
    expect(result.events?.[4]).toMatchObject({ description: 'Arrived at International Hub', provider_code: 'TN003' });
    expect(result.events?.[5]?.location).toBe('');
  });

  it('lets a scan stored with the "In Transit" office lose it in place', () => {
    expect(sameInstantIdentityPolicy('pos-malaysia')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('pos-malaysia', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['pos-malaysia'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'in_transit', description: 'Sorting in progress', location: 'In Transit', providerCode: '01' };
    expect(policy?.matches?.({ ...stored, location: '' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: '' }, { ...stored, location: 'Test Hub Shah Alam' })).toBe(false);
    expect(policy?.matches?.({ ...stored, location: 'Test Hub Shah Alam' }, stored)).toBe(false);
  });

  it('does not date a delivered summary from an older movement scan', () => {
    const result = parsePosMalaysiaTrackingResponse(payload([item({ tracking_data: [
      detail('Out for delivery', 'Courier scan', '23 Feb 2026, 09:52:32 AM'),
    ] })]), TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null });
    expect(result.events?.[0]).toEqual({ description: 'Delivered', stage: 'delivered', provider_code: 'DELIVERED', summary_snapshot: true });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.[1]?.stage).toBe('out_for_delivery');
  });

  it('never retains sender, recipient or proof-of-delivery data', () => {
    const withEpod = item();
    (withEpod.tracking_data as Record<string, unknown>[])[0]!['epod'] = 'https://example.invalid/epod?token=secret';
    const result = parsePosMalaysiaTrackingResponse(payload([withEpod]), TRACKING_NUMBER);
    const serialized = JSON.stringify(result);
    for (const secret of ['+600000000000', '+600000000001', 'sender_data', 'recipient_data', 'epod', 'example.invalid']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'provider_code']);
    const result = parsePosMalaysiaTrackingResponse(payload([item()]), TRACKING_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
  });
});

describe('PosMalaysiaTracker fetch', () => {
  it('posts one connote id with a request id and maps HTTP outcomes', async () => {
    const seen: Array<{ url: string; body: string; requestId: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), body: String(init?.body), requestId: headers.get('P-Request-ID') ?? '' });
      return response(payload([item()]));
    });
    const result = await new PosMalaysiaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://ttu-svc.pos.com.my/api/trackandtrace/v1/request');
    expect(JSON.parse(seen[0]!.body)).toEqual({ connote_ids: [TRACKING_NUMBER], culture: 'en' });
    expect(seen[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('surfaces transport and schema failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 503));
    await expect(new PosMalaysiaTracker({ timeoutMs: 3_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new PosMalaysiaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new PosMalaysiaTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new PosMalaysiaTracker({ timeoutMs: 1_000 }).fetch('nope'))
      .rejects.toThrow(InvalidInputError);
  });

  it('does not turn a missing HTTP endpoint into shipment absence or lose throttling', async () => {
    for (const status of [404, 410]) {
      await expect(new PosMalaysiaTracker({ fetcher: vi.fn().mockResolvedValue(response({}, status)) }).fetch(TRACKING_NUMBER))
        .rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(new PosMalaysiaTracker({ fetcher: vi.fn().mockResolvedValue(new Response('{}', {
      status: 429, headers: { 'Retry-After': '120' },
    })) }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('forwards caller cancellation and deadline through the exported adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });
    const started = performance.now();
    const failure = await instance.track({ number: TRACKING_NUMBER }, { budgetMs: 35 }).then(() => undefined, (error: unknown) => error);
    expect(performance.now() - started).toBeLessThan(1000);
    // A busy runner can spend the budget before the request starts; a request that did start was aborted as a transport failure.
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1);
    expect(failure).toMatchObject({ kind: fetcher.mock.calls.length ? 'transport' : 'budget' });
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const before = fetcher.mock.calls.length;
    const controller = new AbortController();
    const request = instance.track({ number: TRACKING_NUMBER }, { budgetMs: 5000, signal: controller.signal });
    controller.abort(new Error('Synthetic caller cancellation'));
    await expect(request).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(before + 1);
    expect(fetcher.mock.calls[before]?.[1]?.signal?.aborted).toBe(true);
  });
});
