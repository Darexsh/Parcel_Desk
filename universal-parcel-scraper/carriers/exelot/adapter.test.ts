import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EXELOT_API, ExelotTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeExelotNumber, parseExelot } from './parser.js';
import { exelotStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'XLT000000001';
const PICKUP = 'XLT000000002';
const UNKNOWN = 'XLT000000003';

type Row = Record<string, unknown>;
type Parcel = Row & { statusHistory: Row[] };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const parcels = (name: string) => JSON.parse(fixture(name)) as Parcel[];
const changed = (name: string, change: (parcel: Parcel, reply: Parcel[]) => void): Parcel[] => {
  const reply = parcels(name);
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => reply(body, { ...init, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const lookup = (response: Response, number = DELIVERED) => carrier(answering(() => response)).track({ number });
const hanging = () => vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
}));

describe('Exelot HTTP adapter', () => {
  it('asks the tracker page’s lookup for the whole number once, anonymously, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('ready-for-pickup')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ExelotTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xlt-000 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EXELOT_API}${PICKUP}?lang=en`);
    expect(String(url)).toBe('https://apiv2p.exelot.com/api/v2/parcels/tracking/details/XLT000000002?lang=en');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']));
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['authorization']));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'exelot', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first, on the instants Exelot gives, with the places of its facilities', () => {
    const result = parseExelot(parcels('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-03T10:47:21Z', delivered_at: '2026-03-03T10:47:21Z',
      destination_country: 'IL' });
    expect(result).not.toHaveProperty('timezone');
    expect(result).not.toHaveProperty('pickup_point');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.provider_code, event.stage]))
      .toEqual([
        // The delivery happens at the recipient's address: its place is not kept.
        ['2026-03-03T10:47:21Z', 'Delivered', null, '52', 'delivered'],
        ['2026-03-03T05:02:33Z', 'Messenger with package out for delivery', 'Exampleton IL', '50', 'out_for_delivery'],
        ['2026-03-02T14:15:00Z', 'Package in sorting center', 'Exampleton IL', '21', 'in_transit'],
        ['2026-03-02T09:30:00Z', 'Package released from customs', 'Testburg IL', '48', 'in_transit'],
        ['2026-03-01T06:10:00Z', 'Clearance Process Started', 'Testburg IL', '32', 'customs'],
        ['2026-02-28T20:00:00Z', 'Package landed in TLV Airport, IL', 'Testburg IL', '45_01', 'in_transit'],
        ['2026-02-26T13:23:43.570Z', 'Package flight details received', 'GB', '15', 'in_transit'],
        ['2026-02-25T02:44:00Z', 'Package left first processing warehouse', 'Sampleford GB', '13', 'in_transit'],
        ['2026-02-24T11:16:44.774Z', 'Package arrived to preflight warehouse: XYZ', 'Sampleford GB', '14_02', 'accepted'],
        ['2026-02-22T10:18:12.603Z', 'Package details received', 'GB', '00', 'registered'],
      ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
  });

  it('keeps no person, contact, address, remark, order, origin district, partner link or scan note', () => {
    const text = JSON.stringify(parseExelot(parcels('delivered'), DELIVERED)) + JSON.stringify(parseExelot(parcels('ready-for-pickup'), PICKUP));
    for (const kept of ['Dana', '050', 'example.com', 'Sampleville', '"7"', 'noon', 'Samplecounty', 'Sample Couriers', 'couriers.example',
      'opaque', 'Flight XX', 'Example Road', 'Synthetic sub text', 'bakery', '31.0000', '09:00', 'homeDelivery', 'pickupPoint']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('keeps a clock’s own offset, reads a scan with only the printed clock in UTC as the page does, and leaves an unknown code without a stage', () => {
    const result = parseExelot(parcels('ready-for-pickup'), PICKUP);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Package waiting for pickup by buyer',
      last_update: '2026-03-05T08:15:00+02:00', destination_country: 'IL', pickup_point: 'Sample Kiosk\nExample Street 12\nExampleton' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        ['2026-03-05T08:15:00+02:00', 'Package waiting for pickup by buyer', 'Exampleton IL', '53', 'ready_for_pickup'],
        // Scans at one instant keep the reply's order.
        ['2026-03-04T17:00:00Z', 'Synthetic status', 'Exampleton IL', '998', null],
        ['2026-03-04T17:00:00Z', 'Package in sorting center', 'Exampleton IL', '21', 'in_transit'],
        ['2026-03-03T09:05:00Z', 'Package held by customs/security: ID required', 'Testburg IL', '42_14', 'customs'],
        ['2026-03-02T22:40:00Z', 'Package landed in TLV Airport, IL', 'Testburg IL', '45_01', 'in_transit'],
        // A place with a street is not a facility's town.
        ['2026-02-27T10:00:00Z', 'Package details received', null, '00', 'registered'],
      ]);
    expect(result.events![1]).not.toHaveProperty('stage_source');
  });

  it('counts a parcel only when the one parcel answered is the number asked', () => {
    const others: [string, (parcel: Parcel, reply: Parcel[]) => void][] = [
      ['another id', (parcel) => { parcel.id = 'XLT000000009'; }],
      ['another Exelot id', (parcel) => { parcel.xltID = 'XLT000000009'; }],
      ['an Exelot id that is not text', (parcel) => { parcel.xltID = 1; }],
      ['a longer id', (parcel) => { parcel.id = `${DELIVERED}9`; }],
      ['a second parcel', (parcel, reply) => { reply.push({ ...parcel, id: 'XLT000000009' }); }],
      ['the parcel twice', (parcel, reply) => { reply.push(parcel); }],
    ];
    for (const [label, change] of others) {
      expect(() => parseExelot(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // Another number's absence is not this number's.
    expect(() => parseExelot(JSON.parse(fixture('not-found')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseExelot(changed('delivered', (parcel) => { parcel.id = 12345; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a parcel without scans as no history yet, not as found or missing', () => {
    expect(() => parseExelot(changed('delivered', (parcel) => { parcel.statusHistory = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    const broken: [string, (parcel: Parcel, reply: Parcel[]) => void][] = [
      ['no clock', (parcel) => { delete parcel.statusHistory[0]!.dateISO; delete parcel.statusHistory[0]!.date; }],
      ['a clock without an offset and no printed clock', (parcel) => { parcel.statusHistory[0]!.dateISO = '2026-03-03T10:47:21'; delete parcel.statusHistory[0]!.date; }],
      ['an impossible day', (parcel) => { parcel.statusHistory[0]!.dateISO = '2026-02-30T10:47:21Z'; delete parcel.statusHistory[0]!.date; }],
      ['an impossible printed day', (parcel) => { delete parcel.statusHistory[0]!.dateISO; parcel.statusHistory[0]!.date = '30 Feb 2026, 10:47 AM'; }],
      ['no wording', (parcel) => { parcel.statusHistory[0]!.statusText = ' '; }],
      ['wording that is not text', (parcel) => { parcel.statusHistory[0]!.statusText = { en: 'Delivered' }; }],
      ['a code that is not a code', (parcel) => { parcel.statusHistory[0]!.statusCode = 'Delivered to the door'; }],
      ['a sub-code without a code', (parcel) => { parcel.statusHistory[0]!.statusCode = ''; parcel.statusHistory[0]!.statusSubCode = '01'; }],
      ['a scan that is not a record', (parcel) => { parcel.statusHistory[0] = 'Delivered' as unknown as Row; }],
      ['scans that are not a list', (parcel) => { parcel.statusHistory = {} as unknown as Row[]; }],
      ['no scans at all', (parcel) => { delete (parcel as Row).statusHistory; }],
      ['too many scans', (parcel) => { parcel.statusHistory = Array.from({ length: 501 }, () => parcel.statusHistory[0]!); }],
      ['scans on a parcel it did not find', (parcel) => { parcel.parcelStatus = 'notFound'; }],
      ['a parcel that is not a record', (_parcel, reply) => { reply[0] = 'XLT000000001' as unknown as Parcel; }],
    ];
    for (const [label, change] of broken) {
      expect(() => parseExelot(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [[], {}, null, 'XLT000000001', { parcels: parcels('delivered') }]) {
      expect(() => parseExelot(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the lookup’s own absence answer as not found, and keeps a bot check, a moved route and a broken reply apart', async () => {
    await expect(lookup(reply(fixture('not-found')), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // An empty list is what the lookup sends without a number, not an absence.
    await expect(lookup(reply('[]'), UNKNOWN)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><body><div class="g-recaptcha"></div></body></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>403 Forbidden</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A 404 is a moved route, whatever it says.
    await expect(lookup(html('{"URL":"/api/v2/parcels/tracking/details/XLT000000001","Method":"GET"}', { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply(fixture('not-found'), { status: 404 }), UNKNOWN)).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '<html><title>Exelot</title><div id="root"></div></html>', '{}', 'null', '{"error":"Something went wrong"}']) {
      await expect(lookup(html(body)), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = answering(() => new Response('{}', { status }));
      await expect(carrier(fetcher).track({ number: PICKUP })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach Exelot once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('ready-for-pickup')));
    await expect(carrier(fetcher).track({ number: PICKUP }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup(reply('[]', { headers: { 'Content-Length': String(3_000_000) } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers Exelot does not issue, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['XLT00000001', 'XLT0000000001', 'XLU000000001', '000000000001', 'XLTA00000001', '', `XLT${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeExelotNumber('xlt 000-000-001')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: PICKUP }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('ends with the caller’s reason, without a retry, when the caller cancels', async () => {
    const fetcher = hanging();
    await expect(carrier(fetcher).track({ number: PICKUP }, { signal: AbortSignal.abort(new Error('caller cancelled')) }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = createTracker({ fetcher, providers: [], env: {} })
      .track({ number: PICKUP, carrier: 'exelot' }, { signal: controller.signal, budgetMs: 2000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number detection gives Exelot to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith(EXELOT_API) ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'exelot', source: 'exelot', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${EXELOT_API}${DELIVERED}?lang=en`)).toBe(true);
  });

  it('recognizes a parcel the lookup has, and not one it answers is missing or a number Exelot does not issue', async () => {
    await expect(carrier(answering(() => reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T10:47:21.000Z' });
    await expect(carrier(answering(() => reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('XLT00000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(answering(() => html('<title>Just a moment...</title>'))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });
});

describe('Exelot numbers', () => {
  it('accepts every public number, which only Exelot’s rule claims, and reads the tracker links', () => {
    expect(numbers.records.length).toBeGreaterThan(0);
    for (const record of numbers.records) {
      expect(normalizeExelotNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number), record.number).toMatchObject({ carrier: 'exelot', confidence: 'high' });
      // A high-confidence rule needs no recognition to settle the carrier.
      expect(recognitionCandidates(record.number), record.number).toEqual([]);
    }
    for (const link of [`https://go.exelot.com/tracking?barcodes=${DELIVERED}`, `https://myparcel.exelot.com/tracking?barcodes=${DELIVERED}`,
      `https://public.exelot.com/tracking/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'exelot' });
    }
  });
});

describe('Exelot status vocabulary', () => {
  it('records every coded status with the stage the map gives it', () => {
    const coded = statuses.entries.filter((entry): entry is typeof entry & { code: string } => typeof entry.code === 'string');
    expect(coded.filter((entry) => entry.confirmedBy === 'live')).toHaveLength(10);
    for (const entry of coded) {
      expect(exelotStage(entry.code), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'exelot', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('reads a sub-code by its code, and leaves forecasts and administrative steps out on purpose', () => {
    expect(statusMapAnswer({ carrier: 'exelot', providerCode: '42_28', description: 'Synthetic customs wording' })).toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'exelot', providerCode: 'r52', description: 'Returned to sender' })).toEqual({ kind: 'mapped', stage: 'returned' });
    for (const gap of statusMap.gaps) {
      expect(exelotStage(gap.code!), gap.code).toBeUndefined();
      expect(statusMapAnswer({ carrier: 'exelot', providerCode: gap.code!, description: 'Any wording' }), gap.code)
        .toEqual({ kind: 'intentional_gap', note: gap.note });
    }
    expect(statusMapAnswer({ carrier: 'exelot', providerCode: '94_01', description: 'Any wording' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'exelot', providerCode: '998', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'exelot', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
