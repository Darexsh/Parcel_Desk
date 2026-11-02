import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PDN_EXPRESS_API, PdnExpressTracker } from './adapter.js';
import { normalizePdnExpressNumber, parsePdnExpress } from './parser.js';
import { pdnExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'PDN0000000002';
const IN_TRANSIT = 'PDN0000000001';
const UNKNOWN = 'PDN0000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };
type Reply = Row & { data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (code: string, eventTime: string, eventDesc: string, extra: Row = {}): Row => ({ eventCode: code, eventTime,
  eventLocation: 'Sampleton, Netherlands', eventDesc, timezone: 'Europe/Amsterdam', utcTimezone: 'UTC+1', ...extra });

describe('PDN Express HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PdnExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pdn 000-000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PDN_EXPRESS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ action: 'search', orderNos: IN_TRANSIT, locale: 'en' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pdn-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates each scan by the offset the reply states for its zone, in winter too', () => {
    const result = parsePdnExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at our facility.', last_update: '2026-01-13T22:40:16+01:00', expected_delivery: null,
      destination_country: 'NL' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-01-13T22:40:16+01:00', 'D830', 'in_transit', 'NL - Sampleton'],
      ['2026-01-13T14:52:03+01:00', 'D830', 'in_transit', 'Amsterdam, Netherlands'],
      ['2026-01-13T11:09:48+01:00', 'D830', 'accepted', 'Amsterdam, Netherlands'],
      // The merchant's data is clocked in UTC.
      ['2026-01-09T03:27:19Z', 'D800', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
  });

  it('keeps the delivery, the failed attempt and the repeated scan once, without the proof of delivery', () => {
    const result = parsePdnExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your package has been delivered to the Mailbox.', last_update: '2026-08-21T16:42:08+02:00',
      delivered_at: '2026-08-21T16:42:08+02:00', destination_country: 'NL' });
    expect(result.events).toHaveLength(12);
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['D860', 'delivered'], ['D840', 'out_for_delivery'], ['D830', 'in_transit'], ['D830', 'in_transit'], ['D830', 'in_transit'],
      // The recipient's confirmed address moves nothing.
      ['D810', null],
      ['D850', 'failed_attempt'], ['D840', 'out_for_delivery'], ['D830', 'in_transit'], ['D830', 'in_transit'],
      ['D830', 'accepted'], ['D800', 'registered'],
    ]);
    expect(result.events![5]).toMatchObject({ time: '2026-08-20T06:30:00Z', location: 'Customer Service Center' });
    expect(JSON.stringify(result)).not.toMatch(/existsPod|iconUrl|fontColor|Delivered Successfully/);
  });

  it('takes the code’s word for a delay, a wrong address and a return', () => {
    const returned = parsePdnExpress(changed('in-transit', (data) => {
      data.events.unshift(
        scan('D890', '2026-01-16 17:02:10', "Returned - Back to Sender's Warehouse."),
        scan('D814', '2026-01-16 17:02:05', 'Unable to Deliver - Incorrect Address.'),
        scan('D850', '2026-01-15 12:40:00', 'Delivery Delayed - Change the delivery time.'),
      );
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(returned.events!.slice(0, 3).map((event) => event.stage)).toEqual(['returned', 'exception', 'exception']);
    // A notice newer than every scan leaves the stage to the scan before it.
    const noted = parsePdnExpress(changed('in-transit', (data) => {
      data.events.unshift(scan('D810', '2026-01-14 08:00:00', 'Address updated - recipient has provided feedback and confirmed.',
        { timezone: 'Etc/GMT-0', utcTimezone: 'UTC+0', eventLocation: 'Customer Service Center' }));
    }), IN_TRANSIT);
    expect(noted).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Address updated - recipient has provided feedback and confirmed.',
      last_update: '2026-01-14T08:00:00Z' });
  });

  it('keeps a wall clock whose zone and offset disagree, or that names neither', () => {
    const result = parsePdnExpress(changed('in-transit', (data) => {
      data.events[0]!.utcTimezone = 'UTC+2';
      delete data.events[1]!.timezone;
      data.events[2]!.timezone = 'Sample/Nowhere';
      delete data.events[3]!.utcTimezone;
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-13T22:40:16' });
    expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null])).toEqual([
      [null, '2026-01-13T22:40:16'], [null, '2026-01-13T14:52:03'], [null, '2026-01-13T11:09:48'], [null, '2026-01-09T03:27:19'],
    ]);
    // The stated offset settles the hour the clocks repeat when they go back.
    const repeated = parsePdnExpress(changed('in-transit', (data) => {
      data.events.unshift(scan('D830', '2026-10-25 02:30:00', 'Arrived at our facility.'));
    }), IN_TRANSIT);
    expect(repeated.events![0]).toMatchObject({ time: '2026-10-25T02:30:00+01:00' });
    // Summer time on a winter clock names no instant.
    const skipped = parsePdnExpress(changed('in-transit', (data) => {
      data.events.unshift(scan('D830', '2026-03-29 02:30:00', 'Arrived at our facility.', { utcTimezone: 'UTC+2' }));
    }), IN_TRANSIT);
    expect(skipped.events![0]).toMatchObject({ local_time: '2026-03-29T02:30:00' });
  });

  it('keeps a scan without a code, names the status when the scan has no wording, and drops a pickup point', () => {
    const result = parsePdnExpress(changed('in-transit', (data) => {
      delete data.events[0]!.eventCode;
      data.events[1]!.eventDesc = '';
      data.events[1]!.statusCodeConfig = { lanName: 'In Transit' };
      Object.assign(data.events[2]!, { pickupSite: true, pickupSiteId: 'SAMPLE-1', eventLocation: 'Sample Shop, Sample Street 1' });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ description: 'Arrived at our facility.', stage: 'in_transit', stage_source: 'wording:language' });
    expect(result.events![0]).not.toHaveProperty('provider_code');
    expect(result.events![1]).toMatchObject({ description: 'In Transit', provider_code: 'D830' });
    expect(result.events![2]).not.toHaveProperty('location');
  });

  it('reads a history listed oldest first newest first, and a destination it cannot code by name', () => {
    const result = parsePdnExpress(changed('in-transit', (data) => {
      data.events.reverse();
      data.destCountry = 'Sampleland';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-01-13T22:40:16+01:00', destination_country_name: 'Sampleland' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'D800' });
  });

  it('reads the tracker’s notice as not found, and anything else without scans as inconclusive', () => {
    expect(() => parsePdnExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notice = changed('not-found', (data) => { (data.statusCodeConfig as Row).lanName = 'System busy, please try again later.'; });
    expect(() => parsePdnExpress(notice, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdnExpress(changed('delivered', (data) => { data.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A parcel with its destination is not an unknown number, whatever the notice.
    const known = changed('delivered', (data) => {
      delete (data as Row).events;
      data.statusCodeConfig = fixture('not-found').data[0]!.statusCodeConfig;
    });
    expect(() => parsePdnExpress(known, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdnExpress({ ok: false, error: 'upstream' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdnExpress({ ok: false, error: 'missing_order' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parsePdnExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PDN Express answered for another shipment' }));
    // The page itself falls back to the first entry; the adapter takes only the one asked.
    const both = changed('delivered', (_data, body) => { body.data.unshift(fixture('in-transit').data[0]!); });
    expect(parsePdnExpress(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parsePdnExpress(changed('in-transit', (data) => { data.orderNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(4);
    expect(() => parsePdnExpress(changed('in-transit', (data) => { data.orderNo = `${IN_TRANSIT}0`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).ok; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (data: Shipment) => { delete data.orderNo; },
      (data: Shipment) => { data.orderNo = 7; },
      (data: Shipment) => { data.events = 'events' as never; },
      (data: Shipment) => { data.events = Array.from({ length: 501 }, () => data.events[0]!); },
      (data: Shipment) => { data.events[0] = 'scan' as never; },
      (data: Shipment) => { data.events[0]!.eventTime = '13/01/2026 22:40'; },
      (data: Shipment) => { data.events[0]!.eventTime = '2026-01-13 24:00:00'; },
      (data: Shipment) => { data.events[0]!.eventTime = '2026-02-30 10:00:00'; },
      (data: Shipment) => { delete data.events[0]!.eventTime; },
      (data: Shipment) => { data.events[0]!.eventCode = 'D 830'; },
      (data: Shipment) => { data.events[0]!.eventDesc = ['Arrived']; },
      (data: Shipment) => { data.events[0]!.eventDesc = ''; delete data.events[0]!.statusCodeConfig; },
      (data: Shipment) => { data.events[0]!.utcTimezone = 2; },
      (data: Shipment) => { data.destCountry = { code: 'NL' }; },
    ]) {
      expect(() => parsePdnExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>Page not found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://pdn.express/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ ok: false, error: 'invalid_json' }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>PDN Express</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ ok: false, error: 'upstream' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last scan’s instant, and asks nothing for a number PDN Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-08-21T14:42:08.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('PDN000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers PDN Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['PDN000000000', 'PDN00000000000', 'PDX0000000000', '0000000000', `PDN${'0'.repeat(62)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePdnExpressNumber('pdn 0000-000-002')).toBe(DELIVERED);
  });

  it('retries a read that fails to reach the site once, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under PDN Express, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pdn-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pdn-express', source: 'pdn-express', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pdn-express', source: 'pdn-express' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PDN_EXPRESS_API)).toBe(true);
  });
});

describe('PDN Express numbers', () => {
  it('claims PDN and ten digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'pdn-express', confidence: 'high' });
    }
    for (const number of ['PDN000000000', 'PDN00000000000']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('pdn-express');
    }
  });
});

describe('PDN Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(pdnExpressStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'pdn-express', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pdnExpressStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pdn-express', providerCode: 'D850', description: 'Unable to Deliver - Recipient not found.' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'pdn-express', providerCode: 'D999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(pdnExpressStage('D845', 'Your package is ready for pickup.')).toMatchObject({ stage: 'ready_for_pickup' });
    expect(pdnExpressStage('D999', 'Synthetic note')).toBeNull();
    expect(pdnExpressStage('d860', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
