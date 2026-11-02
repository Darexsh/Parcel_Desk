import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TCS_API, TcsTracker } from './adapter.js';
import { normalizeTcsNumber, parseTcs } from './parser.js';
import { statusMap, tcsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '90000000011';
const IN_TRANSIT = '900000000022';
const ATTEMPTED = '90000000000033';
const UNKNOWN = '90000000044';
const BOOKED = '90000000055';

type Row = Record<string, unknown>;
type Data = Row & { shipmentinfo: Row[]; deliveryinfo: Row[] | null; checkpoints: Row[] | null };
type Reply = Row & { responseData: Data };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Data, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.responseData, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TCS HTTP adapter', () => {
  it('posts the whole consignment number to the tracking page’s bridge once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TcsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TCS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ body: { url: 'trackapinew', type: 'GET', headers: {}, payload: {}, param: `consignee=${IN_TRANSIT}` } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tcs-pakistan', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery in Karachi time, with stations on facility scans and a repeated checkpoint once', () => {
    const result = parseTcs(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: '2026-03-05T14:42:00+05:00', expected_delivery: null,
      delivered_at: '2026-03-05T14:42:00+05:00' });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      // The delivery checkpoint's `recievedby` is the signatory, not a place.
      ['2026-03-05T14:42:00+05:00', 'Shipment Delivered', null, 'delivered'],
      ['2026-03-05T09:05:00+05:00', 'Out For Delivery', null, 'out_for_delivery'],
      ['2026-03-04T03:12:00+05:00', 'Arrived at TCS Facility', 'SOUTHPORT', 'in_transit'],
      ['2026-03-03T01:40:00+05:00', 'Departed From TCS Facility', 'MIDHUB', 'in_transit'],
      ['2026-03-02T21:30:00+05:00', 'Departed From TCS Facility', 'NORTHVILLE', 'in_transit'],
      ['2026-03-02T18:05:00+05:00', 'Shipment Picked Up', 'NORTHVILLE', 'accepted'],
    ]);
    // Names, the signatory and the merchant's reference stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|FICTIVE|Fictive|ORDER-0001/);
  });

  it('reads a consignment on its way, with the expected delivery date of its summary', () => {
    const result = parseTcs(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at TCS Facility', last_update: '2026-04-11T06:20:00+05:00', expected_delivery: '2026-04-12' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(3);
  });

  it('reads a consignment out for delivery again after an attempt', () => {
    const result = parseTcs(fixture('attempted'), ATTEMPTED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out For Delivery',
      last_update: '2026-06-15T15:09:00+05:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.description, event.stage ?? null])).toEqual([
      ['Out For Delivery', 'out_for_delivery'],
      ['Scheduled For Next Delivery Cycle', 'in_transit'],
      ['Recipient Premises Closed (For Additional Info Contact Local TCS Office)', 'failed_attempt'],
      ['Arrived at TCS Facility', 'in_transit'],
      ['Shipment Picked Up', 'accepted'],
    ]);
  });

  it('reads a consignment listed without checkpoints as a summary of its status line or newest delivery record', () => {
    const booked = parseTcs(fixture('booked'), BOOKED);
    expect(booked).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your shipment is in Transit', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(JSON.stringify(booked)).not.toMatch(/000-000|WhatsApp/);
    expect(parseTcs(changed('delivered', (data) => { data.checkpoints = null; }), DELIVERED)).toEqual({ status: 'delivered',
      current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered', provider_code: 'OK',
      last_update: '2026-03-05T14:42:00+05:00', expected_delivery: null, delivered_at: '2026-03-05T14:42:00+05:00', summary_only: true, events: [] });
    expect(() => parseTcs(changed('booked', (data) => { data.shipmentsummary = 'Dear Customer'; }), BOOKED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('keeps the wall clocks of a consignment that crosses the border', () => {
    const abroad = parseTcs(changed('delivered', (data) => { data.shipmentinfo[0]!.destinationcountry = 'ARE'; }), DELIVERED);
    expect(abroad).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-03-05T14:42' });
    expect(abroad).not.toHaveProperty('delivered_at');
    expect(abroad.events![2]).toEqual({ local_time: '2026-03-04T03:12', description: 'Arrived at TCS Facility', location: 'SOUTHPORT',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads the empty reply as not found and another consignment as inconclusive', () => {
    expect(() => parseTcs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTcs(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TCS answered for another consignment' }));
    // A number that only shares the start of the one asked is another consignment.
    expect(() => parseTcs(changed('delivered', (data) => { data.shipmentinfo[0]!.consignmentno = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTcs(changed('delivered', (data) => { data.checkpoints![3]!.consignmentno = '90000000012'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTcs(changed('not-found', (_data, reply) => { reply.responseData.message = 'FAILED'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, body] of [
      null,
      [],
      { responseData: fixture('delivered').responseData },
      { isSuccess: false, responseData: { errors: { consignee: ['The consignee field is required.'] }, status: 400 } },
      changed('not-found', (data) => { data.shipmentsummary = 'Something else'; }),
      changed('not-found', (data) => { data.shipmentsummary = 12; }),
      changed('delivered', (data) => { data.shipmentinfo = {} as never; }),
      changed('delivered', (data) => { data.shipmentinfo = []; }),
      changed('delivered', (data) => { data.shipmentinfo[0]!.consignmentno = null; }),
      changed('delivered', (data) => { data.checkpoints = 'none' as never; }),
      changed('delivered', (data) => { data.checkpoints![0] = 'Shipment Delivered' as never; }),
      changed('delivered', (data) => { data.checkpoints![0]!.status = ' '; }),
      changed('delivered', (data) => { data.checkpoints![0]!.status = 7; }),
      changed('delivered', (data) => { data.checkpoints![0]!.datetime = '2026-03-05 14:42'; }),
      changed('delivered', (data) => { data.checkpoints![0]!.datetime = 'Friday Mar 5, 2026 14:42'; }),
      changed('delivered', (data) => { data.checkpoints![0]!.datetime = 'Thursday Mar 5, 2026 24:00'; }),
      changed('delivered', (data) => { data.checkpoints![0]!.datetime = null; }),
      changed('delivered', (data) => { data.deliveryinfo![0]!.status = ''; }),
      changed('delivered', (data) => { data.deliveryinfo![0]!.datetime = 'Thursday Mar 5, 2026'; }),
      changed('delivered', (data) => { data.checkpoints!.push(...Array.from({ length: 300 }, () => data.checkpoints![0]!)); }),
    ].entries()) {
      expect(() => parseTcs(body, DELIVERED), `change ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the relayed service refusals', () => {
    expect(() => parseTcs({ isSuccess: false, responseData: { status: 429 } }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseTcs({ isSuccess: false, responseData: { status: 502 } }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps an unknown consignment, a moved route, a refused request, a bot check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.tcsexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ title: 'One or more validation errors occurred.', status: 400, errors: { 'body.payload': ['The payload field is required.'] } },
      { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The site answers an unknown path with its single-page app.
    await expect(lookup('<!doctype html><html><head><title>Welcome to TCS</title></head><body><div id="root"></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a consignment with checkpoints, and neither an unknown one nor a number TCS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T09:42:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('9000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers TCS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9000000001', '900000000000111', 'AB123456789PK', '9000000001O', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTcsNumber(' 9000-0000-011 ')).toBe(DELIVERED);
    // A leading zero names another consignment, so it stays.
    expect(normalizeTcsNumber('090000000011')).toBe('090000000011');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under TCS to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tcs-pakistan' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tcs-pakistan', source: 'tcs-pakistan', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === TCS_API)).toBe(true);
  });
});

describe('TCS status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(tcsStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tcs-pakistan', providerCode: null, description: 'Arrived at TCS Facility' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'tcs-pakistan', providerCode: null, description: 'Synthetic checkpoint' })).toEqual({ kind: 'unknown' });
    // A wording the map does not know falls to the shared wording rules.
    expect(tcsStage('', 'Returned to shipper')).toMatchObject({ stage: 'returned', source: expect.stringMatching(/^wording:/) });
    expect(tcsStage('', 'Synthetic checkpoint')).toBeNull();
  });
});
