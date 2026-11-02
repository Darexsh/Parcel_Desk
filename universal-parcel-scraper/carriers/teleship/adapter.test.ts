import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TELESHIP_API, TeleshipTracker, teleshipLookupUrl } from './adapter.js';
import { normalizeTeleshipNumber, parseTeleship, parseTeleshipNotFound, teleshipLocation, teleshipWording } from './parser.js';
import { statusMap, teleshipStage, teleshipStatusStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'TSGBUSSMPL01000000001';
const IN_TRANSIT = 'TSGBBESMPL02000000002';
const CANCELLED = 'TSGBFRSMPL03000000003';
const UNKNOWN = 'TSGBUS000000000000000';

type Row = Record<string, unknown>;
type Reply = Row & { events: Row[] };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Teleship HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TeleshipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tsgbbe smpl02-000000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TELESHIP_API}${IN_TRANSIT}`);
    expect(teleshipLookupUrl(IN_TRANSIT.toLowerCase())).toBe(`https://api.teleship.com/api/tracking/${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'teleship', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered journey as instants, newest first, with the last-mile carrier and its number', () => {
    const result = parseTeleship(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-09T18:44:00Z', expected_delivery: null,
      delivered_at: '2026-03-09T18:44:00Z', delivery_carrier: 'usps', delivery_tracking_number: '9400100000000000000001' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-09T18:44:00Z', 'L_901', 'delivered', 'Sample City, US'],
      ['2026-03-09T13:05:00Z', 'L_301', 'out_for_delivery', 'Sample City, US'],
      ['2026-03-06T03:20:00Z', 'L_101', 'in_transit', 'Sample Gateway, US'],
      ['2026-03-05T14:02:00Z', 'C_201', 'in_transit', 'Sample Gateway, US'],
      // The line-haul partner's name leaves the place, as on the page.
      ['2026-03-03T19:30:00Z', 'H_201', 'in_transit', 'Sample Hub, UK'],
      // The repeated hub scan is kept once.
      ['2026-03-03T07:12:00Z', 'H_101', 'in_transit', 'Sample Hub, UK'],
      ['2026-03-02T16:40:00Z', 'F_101', 'accepted', 'Sample Town, UK'],
      ['2026-03-02T10:05:12.345Z', 'S_102', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Neither who signed, the recipient, the merchant's order nor Teleship's shipment ID is kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|Sample Recipient|Sample Street|#0001|00000000-0000|signed|Mark 3|Pro Carrier/i);
  });

  it('reads clearance as customs, and drops a phone number and a place that is only a partner’s name', () => {
    const result = parseTeleship(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'wording:language',
      last_status_text: 'Import clearance', last_update: '2026-04-16T09:15:00Z', expected_delivery: '2026-04-20T21:59:59.999Z',
      delivery_carrier: 'bpost', delivery_tracking_number: '323200000000000000000002' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['C_102', 'customs', 'Sample Port, BE', 'Import clearance'],
      ['C_101', 'customs', 'Sample Port, UK', 'Export clearance'],
      ['H_201', 'in_transit', null, 'Departed hub, driver'],
      ['H_101', 'in_transit', 'Sample Hub, UK', 'Arrived at Teleship hub'],
      ['F_101', 'accepted', 'Sample Town, UK', 'Accepted'],
      ['S_102', 'registered', null, 'Shipment info received by carrier'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
    // A summary beyond transit outranks the clearance scan.
    expect(parseTeleship(changed('in-transit', (body) => { body.status = 'alert'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map', expected_delivery: null });
  });

  it('reads a voided label as an exception without its estimate', () => {
    expect(parseTeleship(fixture('cancelled'), CANCELLED)).toMatchObject({ status: 'exception', current_stage: 'exception',
      current_stage_source: 'carrier_map', last_status_text: 'Shipment cancelled by shipper', last_update: '2026-01-07T22:13:44.857Z',
      expected_delivery: null, events: [{ provider_code: 'S_902', stage: 'exception' }, { provider_code: 'S_102', stage: 'registered' }] });
  });

  it('names the last-mile carrier only when the catalog knows it and its link agrees', () => {
    const partner = (lastMile: unknown) => parseTeleship(changed('in-transit', (body) => { body.lastMile = lastMile; }), IN_TRANSIT);
    expect(partner({ carrier: 'Sample Couriers', trackingNumber: 'SMPL0002' })).toMatchObject({ delivery_tracking_number: 'SMPL0002' });
    expect(partner({ carrier: 'Sample Couriers', trackingNumber: 'SMPL0002' })).not.toHaveProperty('delivery_carrier');
    expect(partner({ carrier: 'bpost', trackingNumber: 'SMPL0002', trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=SMPL0002' }))
      .not.toHaveProperty('delivery_carrier');
    // A USPS routing barcode keeps its package number, and the recipient's ZIP code goes.
    expect(partner({ carrier: 'USPS', trackingNumber: '420000009400100000000000000006' }))
      .toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9400100000000000000006' });
    for (const lastMile of [null, undefined, { carrier: 'bpost', trackingNumber: '' }, { carrier: 'bpost', trackingNumber: IN_TRANSIT }]) {
      const result = partner(lastMile);
      expect(result).not.toHaveProperty('delivery_tracking_number');
      expect(result).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads a history listed out of order newest first', () => {
    const result = parseTeleship(changed('delivered', (body) => { body.events.reverse(); }), DELIVERED);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['L_901', 'L_301', 'L_101', 'C_201', 'H_201', 'H_101', 'F_101', 'S_102']);
  });

  it('keeps a scan without a type by its wording, and one the rules cannot read without a stage', () => {
    const result = parseTeleship(changed('in-transit', (body) => {
      delete body.events[5]!.type;
      body.events.push({ code: 'Z_001', description: 'Synthetic note', timestamp: '2026-04-17T10:00:00.000+01:00' });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-04-17T10:00:00+01:00', description: 'Synthetic note', provider_code: 'Z_001' });
    expect(result.events![1]).toMatchObject({ provider_code: 'C_102', stage: 'customs', stage_source: 'wording:language' });
    expect(result).toMatchObject({ current_stage: 'customs', last_status_text: 'Synthetic note' });
  });

  it('takes people and phone numbers out of the wording and partners out of the place', () => {
    expect(teleshipWording('Delivered, signed for by SAMPLE PERSON')).toBe('Delivered');
    expect(teleshipWording('Delivered - Signed by: Sample Person')).toBe('Delivered');
    // "Received by" names the carrier that took the parcel over.
    expect(teleshipWording('Received by last-mile carrier')).toBe('Received by last-mile carrier');
    expect(teleshipWording('Call +00 (0) 000 000 0000 to arrange delivery')).toBe('Call to arrange delivery');
    expect(teleshipWording('Delivery date 2026-05-20')).toBe('Delivery date 2026-05-20');
    expect(teleshipLocation('Mark 3, Sample Hub, UK')).toBe('Sample Hub, UK');
    expect(teleshipLocation('Sample Hub, SEKO')).toBe('Sample Hub');
    expect(teleshipLocation('ProCarrier')).toBe('');
    expect(teleshipLocation('Sample City, US')).toBe('Sample City, US');
  });

  it('reads an unknown number as not found, another refusal as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseTeleshipNotFound(raw('not-found'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTeleshipNotFound(JSON.stringify({ messages: [{ code: 404, message: 'Synthetic failure', details: [] }] })))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTeleshipNotFound('<html><title>404 Not Found</title></html>')).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTeleshipNotFound(JSON.stringify({ statusCode: 404 }))).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTeleship(changed('delivered', (body) => { body.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTeleship(changed('delivered', (body) => { delete (body as Row).events; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseTeleship(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Teleship answered for another shipment' }));
    expect(parseTeleship(changed('in-transit', (body) => { body.trackingNumber = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.trackingNumber; },
      (body: Reply) => { body.trackingNumber = 7; },
      (body: Reply) => { body.events = 'events' as never; },
      (body: Reply) => { body.events = Array.from({ length: 501 }, () => body.events[0]!); },
      (body: Reply) => { body.events[0] = 'scan' as never; },
      (body: Reply) => { body.events[0]!.timestamp = '2026-04-13 08:51'; },
      // A clock without an offset is not one of Teleship's instants.
      (body: Reply) => { body.events[0]!.timestamp = '2026-04-13T08:51:30'; },
      (body: Reply) => { body.events[0]!.timestamp = '2026-02-30T08:51:30Z'; },
      (body: Reply) => { delete body.events[0]!.timestamp; },
      (body: Reply) => { body.events[0]!.description = ['Accepted']; },
      (body: Reply) => { body.events[0]!.description = ''; },
      (body: Reply) => { body.events[0]!.type = 1; },
      (body: Reply) => { body.status = 7; },
      (body: Reply) => { body.estimatedDelivery = 'soon'; },
      (body: Reply) => { body.lastMile = 'bpost'; },
    ]) {
      expect(() => parseTeleship(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTeleship('shipment', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(raw('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://teleship.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A not-found message in a 200 reply is no shipment either.
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Teleship</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number by its newest scan and the unknown-number answer, and asks nothing for a number Teleship does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(raw('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-09T18:44:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1234567890')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Teleship does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A DHL waybill on Teleship's DHL service, and a last-mile number, belong to their carriers.
    for (const number of ['1234567890', '9400100000000000000001', 'TSGB00000000000', 'TSGBUS00000000', `TSGBUS${'0'.repeat(31)}`, 'TS-GB']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTeleshipNumber('tsgbus smpl01-000000001')).toBe(DELIVERED);
    // The FAQ's fifteen characters may be the whole ID.
    expect(normalizeTeleshipNumber('TSGBUS000000001')).toBe('TSGBUS000000001');
  });

  it('tries a read that does not reach Teleship once more inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under Teleship, or detected as one of its IDs, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'teleship' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'teleship', source: 'teleship', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${TELESHIP_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Teleship numbers', () => {
  it('suggests its own IDs for confirmation', () => {
    for (const number of [DELIVERED, IN_TRANSIT, CANCELLED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: ['teleship'] });
    }
    for (const number of ['TSGBUS000000000', 'TSGBUS0000000000000000', 'TSUSGB000000000000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('teleship');
    }
  });
});

describe('Teleship status vocabulary', () => {
  it('records every status word, code and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) {
        expect(teleshipStage('', entry.wording)?.stage, entry.wording).toBe(entry.stage);
      } else if (/^[A-Z]_\d+$/.test(entry.code)) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'teleship', providerCode: entry.code, description: entry.wording }), entry.code)
          .toEqual({ kind: 'mapped', stage: entry.stage });
      } else {
        expect(teleshipStatusStage(entry.code), entry.code).toBe(entry.stage);
        expect(teleshipStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      }
    }
    expect(statusMapAnswer({ carrier: 'teleship', providerCode: 'Z_001', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(teleshipStage('in_transit', 'Held by customs')).toEqual({ stage: 'customs', source: 'wording:language' });
    expect(teleshipStage('in_transit', 'Customs released')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(teleshipStage('alert', 'Held by customs')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(teleshipStage('', 'Synthetic note')).toBeNull();
  });
});
