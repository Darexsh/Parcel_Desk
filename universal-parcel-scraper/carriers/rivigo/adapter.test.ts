import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, rivigoLookupUrl, RivigoTracker } from './adapter.js';
import { normalizeRivigoNumber, parseRivigo } from './parser.js';
import { rivigoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '3000000101';
const MOVING = '3000000102';
const UNKNOWN = '3000000100';
const WITHHELD = '3000000103';

type Row = Record<string, unknown>;
type Payload = Record<string, unknown> & { transitHistory: Row[]; consignmentDto: Row };
type Reply = Record<string, unknown> & { payload: Payload };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (payload: Payload, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.payload, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number });
const answering = (...responses: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
};
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// Epoch milliseconds of a clock in India.
const ist = (clock: string) => Date.parse(`${clock}+05:30`);

describe('Rivigo HTTP adapter', () => {
  it('asks Zoom’s consignment lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RivigoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3000-000-102 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://zoom-api.rivigo.com/tracking/v2/cnote/${MOVING}`);
    expect(String(url)).toBe(rivigoLookupUrl(MOVING));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    // No client build: an outdated one gets an empty reply.
    expect(Object.keys(init!.headers as Record<string, string>)).toEqual(['Accept', 'User-Agent']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'rivigo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its scans as instants in UTC, newest first, without the parties, staff or proof of delivery', () => {
    const result = parseRivigo(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-09-16T09:15:00Z', expected_delivery: null,
      delivered_at: '2026-09-16T09:15:00Z',
      events: [
        { time: '2026-09-16T09:15:00Z', location: 'Testnagar', description: 'Delivered', provider_code: 'DELIVERED', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-09-16T04:00:00Z', location: 'Testnagar', description: 'Out For Delivery', provider_code: 'OUT_FOR_DELIVERY',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-09-16T01:35:00Z', location: 'Testnagar', description: 'Destination PC - Unloaded', provider_code: 'UNLOADED',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-09-16T00:50:00Z', location: 'Testnagar', description: 'Destination PC - IN', provider_code: 'RECEIVED_AT_OU',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-09-15T14:30:00Z', location: 'Testnagar', description: 'Intransit To:', provider_code: 'INTRANSIT_TO_OU',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-09-14T18:25:00Z', location: 'Exampur', description: 'Origin PC - OUT', provider_code: 'LOADED', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-09-14T13:10:00Z', location: 'Exampur', description: 'Origin PC - IN', provider_code: 'RECEIVED_AT_OU', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-09-14T04:45:00Z', location: 'Exampur', description: 'Pickup', provider_code: 'CREATED', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|Sample|Example Road|Test Street|0000000000|XX00XX|example\.invalid|SYNTH/);
  });

  it('leaves out the arrival estimate of the leg a consignment is on, and keeps the delivery estimate as a day in India', () => {
    const result = parseRivigo(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Origin PC - OUT',
      last_update: '2026-11-02T15:40:00Z', expected_delivery: '2026-11-05' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-11-02T15:40:00Z', 'Origin PC - OUT', 'in_transit'],
      ['2026-11-02T07:00:00Z', 'Origin PC - IN', 'in_transit'],
      ['2026-11-02T05:35:00Z', 'Pickup', 'accepted'],
      ['2026-11-02T04:20:00Z', 'Booked', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|Example Supplies|Test Mart|0000000000/);
    // A consignment without an estimate has none.
    expect(parseRivigo(changed('in-transit', (payload) => { delete payload.edd; }), MOVING)).toMatchObject({ expected_delivery: null });
    expect(parseRivigo(changed('in-transit', (payload) => { payload.edd = '05 Nov 26'; }), MOVING)).toMatchObject({ expected_delivery: null });
  });

  it('orders scans by their instants, keeps equal scans once, words a scan without wording by its code, and lets the newest staged scan decide', () => {
    const result = parseRivigo(changed('delivered', (payload) => {
      const rows = payload.transitHistory;
      // A later row at the same instant is the newer scan.
      rows.splice(rows.length - 1, 0, { activity: 'Synthetic note', status: null, city: null, dateAndTime: ist('2026-09-16T14:45') });
      rows.push({ ...rows[0]! });
      rows.push({ activity: null, status: 'DELIVERED_POD_PENDING', city: 'Testnagar', dateAndTime: ist('2026-09-16T15:00') });
      rows.push({ activity: 'Synthetic row', status: 'LOADED', city: 'Testnagar', dateAndTime: null });
      rows.push({ activity: '', status: '', city: 'Testnagar', dateAndTime: ist('2026-09-16T15:05') });
    }), DELIVERED);
    expect(result.events!.slice(0, 3).map((event) => [event.time, event.description, event.provider_code ?? null, event.stage ?? null])).toEqual([
      ['2026-09-16T09:30:00Z', 'DELIVERED POD PENDING', 'DELIVERED_POD_PENDING', 'delivered'],
      ['2026-09-16T09:15:00Z', 'Delivered', 'DELIVERED', 'delivered'],
      ['2026-09-16T09:15:00Z', 'Synthetic note', null, null],
    ]);
    expect(result.events).toHaveLength(10);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-09-16T09:30:00Z' });
    // A failed attempt after the last delivery attempt is the current stage.
    const missed = parseRivigo(changed('delivered', (payload) => {
      payload.transitHistory.splice(-1, 1, { activity: 'Undelivered', status: 'UNDELIVERED', city: 'Testnagar', dateAndTime: ist('2026-09-16T18:00') });
    }), DELIVERED);
    expect(missed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Undelivered' });
    expect(missed).not.toHaveProperty('delivered_at');
    // A code the map does not know falls to the shared wording rules.
    const worded = parseRivigo(changed('in-transit', (payload) => {
      payload.transitHistory.splice(-1, 0, { activity: 'Out for delivery', status: 'SYNTHETIC_CODE', city: 'Testnagar', dateAndTime: ist('2026-11-03T09:00') });
    }), MOVING);
    expect(worded).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });
    // Rows that all lack a time, or none at all, are no history.
    for (const transitHistory of [[], null, [{ activity: 'Pickup', status: 'CREATED', city: 'Exampur', dateAndTime: null }]]) {
      expect(() => parseRivigo(changed('delivered', (payload) => { payload.transitHistory = transitHistory as Row[]; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps a partial delivery and a consignment on its way back from reading as delivered', () => {
    const split = parseRivigo(changed('delivered', (payload) => {
      payload.externalChildCnDto = { childCnotes: ['3000000199'], totalBoxesInChildCns: 1, originalNumberOfBoxes: 3 };
    }), DELIVERED);
    expect(split).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      expected_delivery: '2026-09-17' });
    expect(split).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(split)).not.toContain('3000000199');
    expect(parseRivigo(changed('delivered', (payload) => { payload.status = 'PARTIALLY_DELIVERED'; }), DELIVERED))
      .toMatchObject({ current_stage: 'in_transit' });
    expect(parseRivigo(changed('delivered', (payload) => { payload.externalChildCnDto = { childCnotes: [] }; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
    const back = parseRivigo(changed('in-transit', (payload) => {
      payload.reverseMovementDTO = { consignmentMovementType: 'RETURN', cnote: '3000000198' };
    }), MOVING);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', expected_delivery: null });
    expect(JSON.stringify(back)).not.toContain('3000000198');
    // The return consignment itself is tracked as any other.
    expect(parseRivigo(changed('in-transit', (payload) => {
      payload.reverseMovementDTO = { consignmentMovementType: 'FORWARD', cnote: '3000000198' };
    }), MOVING)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('marks a history whose earlier part the page links elsewhere as truncated', () => {
    expect(parseRivigo(changed('in-transit', (payload) => { payload.lfTrackingUrl = 'https://example.invalid/track'; }), MOVING))
      .toMatchObject({ history_truncated: true });
    expect(parseRivigo(changed('in-transit', (payload) => { payload.lfTrackingUrl = ' '; }), MOVING)).not.toHaveProperty('history_truncated');
  });

  it('reads the notice for a number Rivigo holds nothing under as not found, and a withheld consignment as inconclusive', async () => {
    expect(() => parseRivigo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(answering(reply(fixture('not-found'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseRivigo(fixture('withheld'), WITHHELD)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'tracking_withheld' }));
    await expect(lookup(answering(reply(fixture('withheld'))), WITHHELD)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    // Another notice is no answer about the consignment.
    for (const errorMessage of ['Synthetic notice', 'Error while fetching tracking information', 7, null]) {
      expect(() => parseRivigo({ ...fixture('not-found'), errorMessage }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the answer to the whole number asked', async () => {
    expect(() => parseRivigo(fixture('delivered'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Rivigo answered for another consignment' }));
    await expect(lookup(answering(reply(fixture('delivered'))), '3000000110')).rejects.toMatchObject({ kind: 'indeterminate' });
    // Either number in the reply must be the one asked.
    expect(() => parseRivigo(changed('delivered', (payload) => { payload.consignmentDto.cnote = '3000000199'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRivigo(changed('delivered', (payload) => { payload.cnote = '30000001010'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRivigo(changed('delivered', (payload) => { delete payload.cnote; delete payload.consignmentDto.cnote; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseRivigo(changed('delivered', (payload) => { delete payload.cnote; }), DELIVERED)).toMatchObject({ status: 'delivered' });
    expect(parseRivigo(changed('delivered', (payload) => { payload.cnote = 3000000101; delete (payload as Partial<Payload>).consignmentDto; }), DELIVERED))
      .toMatchObject({ status: 'delivered' });
  });

  it('keeps a browser check, a moved route, an outdated client and a changed reply apart from a missing consignment', async () => {
    await expect(lookup(answering(reply(CHECK, { headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(reply(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    for (const moved of [reply({ status: 404, error: 'Not Found', path: '/tracking/v2/cnote/3000000101' }, { status: 404 }), reply('', { status: 410 }),
      new Response(null, { status: 302, headers: { Location: 'https://zoom.rivigo.com/' } })]) {
      await expect(lookup(answering(moved))).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(lookup(answering(new Response(null, { status: 205 })))).rejects.toMatchObject({ kind: 'schema', status: 205 });
    // The tracking page in place of the lookup is a changed route, not a missing consignment.
    await expect(lookup(answering(reply('<!doctype html><html><head><title>Zoom</title></head><body ng-app="zoomApp"></body></html>',
      { headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (payload: Payload) => { payload.transitHistory = 'none' as unknown as Row[]; },
      (payload: Payload) => { payload.transitHistory[0]!.dateAndTime = '2026-09-14T10:15:00'; },
      (payload: Payload) => { payload.transitHistory[0]!.dateAndTime = 1789361100.5; },
      (payload: Payload) => { payload.transitHistory[0]!.dateAndTime = 1789361100; },
      (payload: Payload) => { payload.transitHistory[0]!.dateAndTime = 0; },
      (payload: Payload) => { payload.transitHistory[0]!.activity = 12; },
      (payload: Payload) => { payload.transitHistory[0]!.city = { name: 'Exampur' }; },
      (payload: Payload) => { payload.transitHistory[0]!.status = ['CREATED']; },
      (payload: Payload) => { payload.transitHistory[1] = 'scan' as unknown as Row; },
      (payload: Payload) => { payload.transitHistory = Array.from({ length: 501 }, () => payload.transitHistory[0]!); },
      (payload: Payload) => { payload.consignmentDto = 'consignment' as unknown as Row; },
      (payload: Payload) => { payload.cnote = { value: DELIVERED }; },
      (payload: Payload) => { payload.externalChildCnDto = 'children'; },
      (payload: Payload) => { payload.reverseMovementDTO = { consignmentMovementType: 1 }; },
    ]) {
      expect(() => parseRivigo(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { status: 'SUCCESS' }, { status: 'SUCCESS', payload: [] }, { status: 'PENDING', payload: {} }]) {
      expect(() => parseRivigo(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ message: 'Synthetic failure' }, { status }));
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known consignment and the not-found notice, leaves a withheld one open, and asks nothing about a number Rivigo does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('withheld')))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-16T09:15:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(WITHHELD)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    await expect(carrier(fetcher).recognize!(MOVING)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('300000010')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('takes ten digits, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['300000010', '30000001011', 'A300000101', '300000010A', 'RV3000000101', `3${'0'.repeat(70)}`]) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRivigoNumber(' 300 000 0101 ')).toBe(DELIVERED);
    expect(normalizeRivigoNumber('3000-000-101')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(answering(new Response(new Uint8Array(1_100_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number the caller names Rivigo’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'rivigo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'rivigo', source: 'rivigo', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === rivigoLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Rivigo numbers', () => {
  it('claims no ten-digit number, and reads the number from either Zoom host’s tracking link', () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('rivigo');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('rivigo');
    for (const link of [`https://zoom.rivigo.com/#/trackconsignment/${DELIVERED}`,
      `https://zoom-ops.rivigo.com/#/trackconsignment/${DELIVERED}?redirectedFromRivigo=true`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'rivigo', source: 'link' });
    }
  });
});

type Entry = { code: string; wording?: string; stage?: string };

describe('Rivigo status vocabulary', () => {
  it('maps every code recorded to its stage, and every code the fixtures carry is recorded', () => {
    for (const entry of statuses.entries as Entry[]) {
      // A scan without wording is worded by its code, as the parser writes it.
      const wording = entry.wording ?? entry.code.replaceAll('_', ' ');
      expect(statusMap.stage(entry.code, normalizeStatusWording(wording)), `${entry.code} ${wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'rivigo', providerCode: entry.code, description: wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => entry.code));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parseRivigo(fixture(name), number).events!) {
        expect(recorded.has(event.provider_code!), event.provider_code).toBe(true);
      }
    }
    // Only a booking or first leg worded Pickup is the collection.
    expect(rivigoStage('RECEIVED_AT_OU', 'Pickup')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(rivigoStage('created', 'pickup')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(rivigoStage('', 'Synthetic status')).toBeNull();
    expect(statusMapAnswer({ carrier: 'rivigo', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'rivigo', providerCode: 'SYNTHETIC', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
