import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PTS_API, PtsTracker } from './adapter.js';
import { normalizePtsNumber, parsePts } from './parser.js';
import { ptsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic PTS numbers, and the partner number of the parcel asked by it.
const DELIVERED = '1000000001';
const RETURNED = '1000000002';
const TRANSIT = '1000000003';
const PARTNERED = '1000000004';
const PARTNER = '90010000000004';
const UNKNOWN = '1000000000';

const reply = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (result: ReturnType<typeof parsePts>) => result.events!.map((event) =>
  [event.local_time, event.description, event.location ?? null, event.provider_code ?? null, event.stage ?? null]);
const changed = (name: string, change: (response: Record<string, unknown>) => void) => {
  const payload = reply(name);
  change(payload.response as Record<string, unknown>);
  return payload;
};
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('PTS Worldwide Express HTTP adapter', () => {
  it('asks the tracking page\'s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PtsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100 000 0003 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PTS_API}?trackingNumber=${TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pts-worldwide-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery abroad in Istanbul time, once per scan, and hands it to the partner that delivered it', () => {
    const result = parsePts(reply('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-09T11:21:00', expected_delivery: null,
      destination_country: 'US', delivery_carrier: 'ups', delivery_tracking_number: '1Z0000000000000019' });
    expect(summary(result)).toEqual([
      ['2026-03-09T11:21:00', 'Delivered', null, '999', 'delivered'],
      ['2026-03-09T05:16:00', 'Out for Delivery', null, '300', 'out_for_delivery'],
      ['2026-03-09T04:30:00', 'Scheduled for Delivery', null, '992', 'in_transit'],
      // The repeated scan is kept once.
      ['2026-03-05T12:38:00', 'UNDER CUSTOMS CLEARANCE', null, '255', 'customs'],
      // A delay notice moves nothing.
      ['2026-03-04T13:07:00', 'Transfer Delay', null, '280', null],
      ['2026-03-03T22:08:00', 'Handed over to Subcontractor', null, '305', 'in_transit'],
      ['2026-03-03T20:05:00', 'Cleared Customs', null, '250', 'in_transit'],
      // A dash is no place.
      ['2026-03-03T18:18:00', 'Arrived at destination facility', null, '225', 'in_transit'],
      ['2026-03-03T09:19:00', 'Loaded on Vehicle', 'SAMPLEKENT', '106', 'in_transit'],
      ['2026-03-02T16:20:00', 'Shipped from Origin', 'TR-Samplekent - Hub', '222', 'in_transit'],
      ['2026-03-02T15:55:00', 'Shipment Reached Center', 'TR-Samplekent - Hub', '219', 'in_transit'],
      ['2026-03-02T15:38:00', 'Shipment Delivered to Operations Center', 'SAMPLEKENT', '017', 'accepted'],
      ['2026-03-02T13:10:00', 'Shipment Picked Up', 'SAMPLEKENT-TURKEY', '001', 'accepted'],
      ['2026-03-02T09:37:00', 'Shipment Data Received', 'SAMPLEKENT-TURKEY', '004', 'registered'],
    ]);
    // The partners' clocks are stored as Istanbul's, so no scan keeps an instant.
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The estimate, the postcode, the masked address and the origin are not kept.
    expect(JSON.stringify(result)).not.toMatch(/"00000"|\*{3}|2026-03-06|"TR"|ups\.com/);
    expect(deliveryHandoff('pts-worldwide-express', DELIVERED, result)).toEqual({ carrier: 'ups', number: '1Z0000000000000019', basis: 'partner' });
  });

  it('reads a return after a failed delivery, with the partner Cainiao names for AliExpress parcels', () => {
    const result = parsePts(reply('returned'), RETURNED);
    expect(result).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'LastMile Return Process Competed', last_update_local: '2026-05-04T12:00:00',
      destination_country: 'CZ', delivery_carrier: 'aliexpress', delivery_tracking_number: 'LP00000000000002' });
    expect(summary(result).slice(0, 4)).toEqual([
      ['2026-05-04T12:00:00', 'LastMile Return Process Competed', null, '987', 'returned'],
      ['2026-04-29T00:00:00', 'Attempted delivery,delivery not possible', null, '420', 'failed_attempt'],
      ['2026-04-12T06:00:00', 'Handed Over to Delivery Agent', null, '998', 'in_transit'],
      ['2026-04-12T06:00:00', 'Delivered to parcelshop.Awaiting pickup', null, '460', 'ready_for_pickup'],
    ]);
    expect(deliveryHandoff('pts-worldwide-express', RETURNED, result)).toMatchObject({ carrier: 'aliexpress', number: 'LP00000000000002' });
  });

  it('reads a parcel in customs without a partner yet, leaving a code no map knows without a stage', () => {
    const result = parsePts(reply('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Transfer Delay', last_update_local: '2026-05-14T09:00:00', destination_country: 'DE' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(summary(result).slice(1, 3)).toEqual([
      ['2026-05-13T14:15:00', 'UNDER CUSTOMS CLEARANCE', null, '255', 'customs'],
      ['2026-05-13T11:30:00', 'Parcel weighed', null, '777', null],
    ]);
    // Without staged scans, the summary stages the parcel.
    const unstaged = changed('in-transit', (response) => {
      response.trackingHistory = (response.trackingHistory as Record<string, unknown>[]).slice(4, 5);
    });
    expect(parsePts(unstaged, TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Parcel weighed' });
    const unknown = changed('in-transit', (response) => {
      response.status = 'SYNTHETIC';
      response.trackingHistory = (response.trackingHistory as Record<string, unknown>[]).slice(4, 5);
    });
    expect(parsePts(unknown, TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: 'Parcel weighed' });
    expect(parsePts(unknown, TRANSIT)).not.toHaveProperty('current_stage');
  });

  it('reads a parcel asked by its partner\'s number as PTS\'s summary, under PTS\'s own number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply('partner-number')));
    const result = await carrier(fetcher).track({ number: PARTNER });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${PTS_API}?trackingNumber=${PARTNER}`);
    expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'In Progress', provider_code: 'PREPARING', last_update: null, expected_delivery: null,
      destination_country: 'TR', delivery_carrier: 'hepsijet', canonical_tracking_number: PARTNERED, summary_only: true, events: [] });
    // HepsiJET's number is the one asked, which the hand-off keeps.
    expect(deliveryHandoff('pts-worldwide-express', PARTNER, result)).toEqual({ carrier: 'hepsijet', number: PARTNER, basis: 'partner' });
    // Asked by PTS's own number, the partner's number is the second reference.
    expect(parsePts(reply('partner-number'), PARTNERED)).toMatchObject({ delivery_carrier: 'hepsijet', delivery_tracking_number: PARTNER });
    expect(parsePts(reply('partner-number'), PARTNERED)).not.toHaveProperty('canonical_tracking_number');
    // A shipment with neither scans nor a summary the page knows has no history.
    const empty = changed('partner-number', (response) => { response.status = 'SYNTHETIC'; });
    expect(() => parsePts(empty, PARTNER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('names a partner only for one catalog carrier whose shape its number has', () => {
    const partnered = (change: (response: Record<string, unknown>) => void) => parsePts(changed('delivered', change), DELIVERED);
    // A name the catalog does not know keeps the number without a partner.
    const unnamed = partnered((response) => { response.lastMileAgentName = 'SAMPLE EXPRESS'; response.lastMileAgentTrackingUrl = null; });
    expect(unnamed).not.toHaveProperty('delivery_carrier');
    expect(unnamed).toMatchObject({ delivery_tracking_number: '1Z0000000000000019' });
    // A number without the partner's shape names no partner.
    const misshapen = partnered((response) => { response.lastMileAgentTrackingNumber = 'SYNTHETIC0000'; });
    expect(misshapen).not.toHaveProperty('delivery_carrier');
    expect(misshapen).toMatchObject({ delivery_tracking_number: 'SYNTHETIC0000' });
    // HepsiJET's number must be the one its own link opens.
    const elsewhere = changed('partner-number', (response) => { response.lastMileAgentTrackingUrl = 'https://www.hepsijet.com/'; });
    expect(parsePts(elsewhere, PARTNERED)).not.toHaveProperty('delivery_carrier');
    // A USPS routing barcode loses the ZIP code it opens with.
    const usps = partnered((response) => {
      response.lastMileAgentName = 'USPS';
      response.lastMileAgentTrackingUrl = null;
      response.lastMileAgentTrackingNumber = '420000009261290000000000000007';
    });
    expect(usps).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9261290000000000000007' });
    expect(JSON.stringify(usps)).not.toMatch(/42000000/);
    // PTS's own number is no second reference.
    expect(partnered((response) => { response.lastMileAgentTrackingNumber = DELIVERED; })).not.toHaveProperty('delivery_tracking_number');
    // An empty or invalid partner number is nothing.
    expect(partnered((response) => { response.lastMileAgentTrackingNumber = ' - '; })).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the tracker\'s T404 answer as not found, and other errors as inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply('not-found'), { status: 400 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parsePts(reply('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const errors of [[{ message: 'Internal error', code: 'T500' }], [], [{ code: 'T404' }, { code: 'T500' }], ['T404']]) {
      expect(() => parsePts({ message: 'Request failed', errors }, UNKNOWN), JSON.stringify(errors))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const payload of [null, [], 'Not found', { message: 'Request failed' }, { response: null }]) {
      expect(() => parsePts(payload, UNKNOWN), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Only the error envelope comes with HTTP 400.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(reply('delivered'), { status: 400 }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole number asked, as PTS\'s or its partner\'s', () => {
    expect(() => parsePts(reply('delivered'), '1000000009'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PTS answered for another shipment' }));
    // The partner's number of another shipment is no alias of the one asked.
    expect(() => parsePts(reply('partner-number'), '90010000000009')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePts(changed('delivered', (response) => { response.ptsNo = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    const scans = (change: (rows: Record<string, unknown>[]) => void) => changed('delivered', (response) => {
      change(response.trackingHistory as Record<string, unknown>[]);
    });
    for (const payload of [
      scans((rows) => { rows[0]!.statusDate = '2026-03-02 06:37'; }),
      scans((rows) => { rows[0]!.statusDate = '2026-02-30T06:37:00.000+00:00'; }),
      scans((rows) => { rows[0]!.statusDate = '2026-03-02T06:37:00'; }),
      scans((rows) => { rows[0]!.statusDate = null; }),
      scans((rows) => { rows[0]!.statusText = ' '; }),
      scans((rows) => { rows[0]!.statusText = 4; }),
      scans((rows) => { rows[0]!.statusCode = '0-4'; }),
      scans((rows) => { rows[0] = 'Delivered' as never; }),
      scans((rows) => { rows.push(...Array.from({ length: 301 }, () => rows[0]!)); }),
      changed('delivered', (response) => { response.trackingHistory = {}; }),
      changed('delivered', (response) => { response.ptsNo = 1000000001; }),
      changed('delivered', (response) => { response.lastMileAgentName = ['UPS']; }),
    ]) {
      expect(() => parsePts(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a block page, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(json(body, init))).track({ number: TRANSIT });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tracking.pts.net/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 400 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>PTS</title><body>Home</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and an unknown one, and asks nothing for a number PTS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(reply('delivered')))
      .mockResolvedValueOnce(json(reply('not-found'), { status: 400 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-09T11:21:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('12345678901')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(reply('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PtsTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pts-worldwide-express', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers PTS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000000', '10000000011', '100000000A', '90020000000004', '9001000000000', '900100000000044',
      '1Z0000000000000019', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePtsNumber(' 9001-0000-0000-04 ')).toBe(PARTNER);
  });

  it('routes a number filed under PTS, or in a tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === `${PTS_API}?trackingNumber=${DELIVERED}`
      ? json(reply('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pts-worldwide-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pts-worldwide-express', source: 'pts-worldwide-express', result: { current_stage: 'delivered' } });
    for (const link of [`https://tracking.pts.net/${DELIVERED}`, `https://www.pts.net/sqlptstrack.php?trackid=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'pts-worldwide-express', confidence: 'high' });
    }
  });
});

describe('PTS Worldwide Express numbers', () => {
  it('leaves its ten and fourteen digits to the caller and links', () => {
    for (const number of [DELIVERED, PARTNER]) expect(detectCarrierMatch(number).candidates, number).not.toContain('pts-worldwide-express');
  });
});

describe('PTS Worldwide Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      if (entry.unmapped) {
        expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(ptsStage(code ?? '', entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'pts-worldwide-express', providerCode: code ?? undefined, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'pts-worldwide-express', providerCode: code ?? undefined, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      if (entry.code && !/^[A-Z_]+$/.test(entry.code)) {
        expect(ptsStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      }
    }
    expect(statusMapAnswer({ carrier: 'pts-worldwide-express', providerCode: '777', description: 'Parcel weighed' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(ptsStage('778', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(ptsStage('777', 'Parcel weighed')).toBeNull();
  });
});
