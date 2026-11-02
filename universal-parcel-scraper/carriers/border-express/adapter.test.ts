import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BORDER_EXPRESS_LOOKUP, BORDER_EXPRESS_VERIFICATION, BorderExpressTracker } from './adapter.js';
import { borderExpressNumber } from './number.js';
import { parseBorderExpress } from './parser.js';
import { borderExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '00000001';
const IN_TRANSIT = 'ZZZZ000001';
// The second unit's label of the consignment on its way.
const LABEL = 'ZZZZBX00000000001002';
const UNKNOWN = 'ZZZZ000000';
const VERIFICATION_ID = '00000001-0000-0000-0000-000000000000';
const COOKIE = 'qt-verification=SyntheticCookie000';

type Row = Record<string, unknown>;
type Entry = Row & { statusHistory: (Row & { statusEvents: Row[] })[]; currentStatus: Row };
type Reply = { consignments: Entry[] };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const changed = (name: string, change: (entry: Entry, body: Reply) => void) => {
  const body = fixture(name);
  change(body.consignments[0]!, body);
  return body;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const verification = (init: ResponseInit = {}, body: unknown = raw('verification')) => json(body, { ...init, headers: {
  'Set-Cookie': `${COOKIE}; expires=Thu, 01 Jan 2026 00:00:40 GMT; domain=bexonlineapi.borderexpress.com.au; path=/; secure; samesite=strict; httponly`,
  ...init.headers } });
const missing = () => json(raw('not-found'), { status: 404, headers: { 'Content-Type': 'application/problem+json; charset=utf-8' } });
/** A transport that verifies, then answers the lookup with `lookup`. */
const site = (lookup: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async (url) =>
  (String(url) === BORDER_EXPRESS_VERIFICATION ? verification() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Border Express HTTP adapter', () => {
  it('verifies as Quick Track does, then looks the whole consignment up with that verification, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BorderExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzzz 000-001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[verifyUrl, verifyInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(verifyUrl).toBe(BORDER_EXPRESS_VERIFICATION);
    expect(verifyInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0', 'bex-application-name': 'bexonline' } });
    expect(url).toBe(`${BORDER_EXPRESS_LOOKUP}?consignmentNumber=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0', 'bex-application-name': 'bexonline',
      'x-qt-verification': VERIFICATION_ID, Cookie: COOKIE,
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'border-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery from the status rows with their offsets, without the draft, the undated pickup step or the people', () => {
    const result = parseBorderExpress(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T14:05:10+11:00', expected_delivery: null,
      delivered_at: '2026-03-12T14:05:10+11:00',
      events: [
        { time: '2026-03-12T14:05:10+11:00', location: 'Sampleton, NSW', description: 'Delivered', provider_code: 'DEL',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-12T08:40:02+11:00', location: 'Sample Depot, NSW', description: 'On Board For Delivery', provider_code: 'OBD',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-11T17:20:33+11:00', location: 'Sample Creek, VIC', description: 'In Transit', provider_code: 'TRN',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-10T11:02:45+11:00', location: 'Sample Creek, VIC', description: 'Shipment Data Received', provider_code: 'SDR',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Unsaved|0000"|00000000000000000000|10\/03\/2026/);
  });

  it('keeps each state’s offset, and the estimate, while the consignment is on its way', () => {
    const result = parseBorderExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: '2026-01-20T05:31:07+11:00', expected_delivery: '2026-01-21', delivered_at: null });
    // Queensland keeps standard time in summer.
    expect(result.events!.map((event) => [event.time, event.location])).toEqual([
      ['2026-01-20T05:31:07+11:00', 'Sample Hub, NSW'],
      ['2026-01-19T12:56:48+10:00', 'Sample Point, QLD'],
    ]);
    expect(result).not.toHaveProperty('canonical_tracking_number');
  });

  it('reads a unit label into its consignment, asks for that and reports it as the canonical number', async () => {
    expect(borderExpressNumber(LABEL)).toEqual({ consignment: IN_TRANSIT, barcode: LABEL });
    // The range is six digits long unless the label holds more.
    expect(borderExpressNumber('ZZZZBX00000010000001')).toEqual({ consignment: 'ZZZZ010000', barcode: 'ZZZZBX00000010000001' });
    expect(borderExpressNumber('ZZZZBX00010000000001')).toEqual({ consignment: 'ZZZZ10000000', barcode: 'ZZZZBX00010000000001' });
    const fetcher = site(() => json(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: LABEL.toLowerCase() }))
      .resolves.toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${BORDER_EXPRESS_LOOKUP}?consignmentNumber=${IN_TRANSIT}`);
  });

  it('takes a unit label only when the consignment’s own labels agree with it', () => {
    // Another unit of the same consignment shares its label stem.
    expect(parseBorderExpress(fixture('in-transit'), 'ZZZZBX00000000001007')).toMatchObject({ canonical_tracking_number: IN_TRANSIT });
    expect(() => parseBorderExpress(changed('in-transit', (entry) => {
      for (const scan of entry.statusHistory[0]!.statusEvents) scan.itemBarcode = 'ZZZZBX00000000999001';
    }), LABEL)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('other labels') }));
    // Without labels of its own, as before any scan or on customer barcodes, the reading stands.
    expect(parseBorderExpress(changed('in-transit', (entry) => {
      for (const scan of entry.statusHistory[0]!.statusEvents) scan.itemBarcode = '00000000000000000000';
    }), LABEL)).toMatchObject({ canonical_tracking_number: IN_TRANSIT });
  });

  it('skips the sender’s booking states and rows without a date, and falls back to the rows for an unmapped summary', () => {
    const result = parseBorderExpress(changed('in-transit', (entry) => {
      entry.currentStatus.integrationCode = 'UNK';
      entry.statusHistory.unshift({ status: 'Ready For Despatch', integrationCode: 'ACT', dateOccurred: '2026-01-20T06:00:00+11:00', statusEvents: [] });
      entry.statusHistory[1]!.suburb = null;
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'In Transit' });
    expect(result.events!.map((event) => event.location ?? null)).toEqual(['NSW', 'Sample Point, QLD']);
    const partial = parseBorderExpress(changed('delivered', (entry) => {
      entry.currentStatus.integrationCode = 'PAR';
      entry.statusHistory[0]!.integrationCode = 'PAR';
      entry.statusHistory[0]!.status = 'Partially Delivered';
    }), DELIVERED);
    expect(partial).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', delivered_at: null, expected_delivery: '2026-03-13' });
    const final = parseBorderExpress(changed('delivered', (entry) => {
      entry.currentStatus.integrationCode = 'FIN';
      entry.statusHistory[0]!.integrationCode = 'FIN';
      entry.statusHistory[0]!.status = 'Partially Delivered - Final';
    }), DELIVERED);
    expect(final).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', expected_delivery: null });
    expect(final.delivered_at).not.toBeNull();
    expect(final.events![0]).toMatchObject({ provider_code: 'FIN', stage: 'delivered', stage_source: 'carrier_map' });
    // A code the map does not know falls to its wording.
    const unknown = parseBorderExpress(changed('in-transit', (entry) => {
      entry.statusHistory.unshift({ status: 'Awaiting Collection', integrationCode: 'AWC', dateOccurred: '2026-01-21T09:00:00+11:00', statusEvents: [] });
      entry.currentStatus.integrationCode = 'AWC';
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'wording:language' });
    expect(unknown.events![0]).toMatchObject({ provider_code: 'AWC', stage: 'ready_for_pickup' });
    expect(() => parseBorderExpress(changed('in-transit', (entry) => {
      entry.statusHistory = entry.statusHistory.filter((row) => row.integrationCode === 'PEN' || row.dateOccurred === null);
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a reply only when one consignment in it is the number asked', () => {
    expect(() => parseBorderExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Border Express answered for another consignment' }));
    expect(() => parseBorderExpress({ consignments: [] }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBorderExpress(changed('in-transit', (entry, body) => { body.consignments.push(entry); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('several') }));
    // Another consignment beside the one asked is left out.
    const other = fixture('delivered').consignments[0]!;
    expect(parseBorderExpress(changed('in-transit', (_entry, body) => { body.consignments.unshift(other); }), IN_TRANSIT).events).toHaveLength(2);
    expect(parseBorderExpress(changed('in-transit', (entry) => { entry.consignmentNumber = 'zzzz000001'; }), IN_TRANSIT).events).toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_entry: Entry, body: Reply) => { delete (body as Row).consignments; },
      (_entry: Entry, body: Reply) => { body.consignments = 'consignment' as never; },
      (_entry: Entry, body: Reply) => { body.consignments = Array.from({ length: 21 }, () => body.consignments[0]!); },
      (_entry: Entry, body: Reply) => { body.consignments.push('consignment' as never); },
      (entry: Entry) => { delete entry.consignmentNumber; },
      (entry: Entry) => { entry.consignmentNumber = 1; },
      (entry: Entry) => { entry.statusHistory = 'rows' as never; },
      (entry: Entry) => { entry.statusHistory = Array.from({ length: 101 }, () => entry.statusHistory[0]!); },
      (entry: Entry) => { entry.statusHistory[0] = 'row' as never; },
      (entry: Entry) => { entry.statusHistory[0]!.dateOccurred = '2026-01-20T05:31:07'; },
      (entry: Entry) => { entry.statusHistory[0]!.dateOccurred = '20/01/2026 05:31'; },
      (entry: Entry) => { entry.statusHistory[0]!.dateOccurred = 1000000000000; },
      (entry: Entry) => { entry.statusHistory[0]!.status = ''; },
      (entry: Entry) => { entry.statusHistory[0]!.status = ['In Transit']; },
      (entry: Entry) => { entry.statusHistory[0]!.integrationCode = 3; },
      (entry: Entry) => { entry.statusHistory[0]!.suburb = { name: 'Sample Hub' }; },
      (entry: Entry) => { entry.statusHistory[0]!.statusEvents = 'scans' as never; },
      (entry: Entry) => { entry.statusHistory[0]!.statusEvents[0] = 'scan' as never; },
      (entry: Entry) => { entry.statusHistory[0]!.statusEvents[0]!.itemBarcode = 7; },
    ]) {
      expect(() => parseBorderExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBorderExpress('consignments', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response, number = UNKNOWN) => carrier(site(response)).track({ number });
    await expect(lookup(missing)).rejects.toMatchObject({ kind: 'not_found' });
    // A route the service does not have answers 404 without the problem reply.
    await expect(lookup(() => new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json({ status: 404, title: 'Something else' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://bexonline.borderexpress.com.au/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>BEX Online</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    // A label whose reading the tracker does not know may be a consignment whose range has another length.
    await expect(lookup(missing, LABEL)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it('reads a refused or broken verification apart from a missing parcel', async () => {
    const verified = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(verified(new Response('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(verified(new Response('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(verified(new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(verified(new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(verified(verification({}, { verificationId: 'synthetic' }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(verified(verification({}, '<html></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('looks up without the cookie when the verification sets none', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => (String(url) === BORDER_EXPRESS_VERIFICATION
      ? json(raw('verification')) : json(fixture('delivered'))));
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the lookup as %s', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('rejects numbers Border Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', '000000000', 'ZZZ000000', 'ZZZZ0000', 'ZZZZ000000000', 'ZZZZBX0000000000001', 'ZZZZBX00000000000000001',
      'ZZZZBX00100000000001', 'ZZZZ000000,ZZZZ000001', 'SAMPLETRACKING', `ZZZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(borderExpressNumber('zzzz 000 001')).toEqual({ consignment: IN_TRANSIT });
    expect(borderExpressNumber('ZZZZ00000001')).toEqual({ consignment: 'ZZZZ00000001' });
  });

  it('tries once more with a new verification when a request fails to reach Border Express', async () => {
    let lookups = 0;
    const fetcher = site(() => {
      if (lookups++ === 0) throw new TypeError('fetch failed');
      return json(fixture('delivered'));
    });
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url).split('?')[0])).toEqual([BORDER_EXPRESS_VERIFICATION, BORDER_EXPRESS_LOOKUP,
      BORDER_EXPRESS_VERIFICATION, BORDER_EXPRESS_LOOKUP]);
  });

  it('ends a hanging verification inside the budget', async () => {
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
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('routes a number filed under Border Express to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'border-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'border-express', source: 'border-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(BORDER_EXPRESS_LOOKUP))).toBe(true);
  });
});

describe('Border Express numbers', () => {
  it('suggests Border Express for its unit labels and leaves consignments to the shapes other carriers share', () => {
    expect(detectCarrierMatch(LABEL)).toMatchObject({ confidence: 'low' });
    expect(detectCarrierMatch(LABEL).candidates).toContain('border-express');
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('border-express');
    expect(detectCarrierMatch(IN_TRANSIT).carrier).not.toBe('border-express');
  });
});

describe('Border Express status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'border-express', providerCode: entry.code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(borderExpressStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(borderExpressStage('XYZ', 'Synthetic note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'border-express', providerCode: 'OBD', description: 'On Board For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'border-express', providerCode: 'XYZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
