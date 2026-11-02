import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, APC_API, ApcPostalLogisticsTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeApcNumber, parseApcPostalLogistics } from './parser.js';
import { apcStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '00000P0000000000000001';
const TRANSIT = '00000A0000000002';
const UNKNOWN = '00000P0000000000000000';
const PARTNER = 'AB000000001GB';

type Row = Record<string, unknown>;
type Parcel = Row & { events: Row[] };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const parcel = (name: string) => JSON.parse(fixture(name)) as Parcel;
const changed = (name: string, change: (parcel: Parcel) => void): Parcel => {
  const reply = parcel(name);
  change(reply);
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

describe('APC Postal Logistics HTTP adapter', () => {
  it('asks the tracker page’s lookup for the whole number once, anonymously, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ApcPostalLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 00000a 0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${APC_API}${TRANSIT}`);
    expect(String(url)).toBe('https://tracking.apc-pli.com/api/track?id=00000A0000000002');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']));
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['authorization']));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'apc-postal-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel handed to a partner in the reply’s order, APC’s scans on their UTC instants and the others on their wall clocks', () => {
    const result = parseApcPostalLogistics(parcel('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered.', last_update: null, last_update_local: '2026-03-12T13:30:43', expected_delivery: null,
      service_name: 'APC Priority DDU w/ DC', destination_country: 'GB', delivery_carrier: 'royal-mail', delivery_tracking_number: PARTNER });
    // The partner's delivery clock is no instant.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result).not.toHaveProperty('timezone');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        // A delivery happens at the recipient's address: its place is not kept.
        ['2026-03-12T13:30:43', 'Delivered.', null, '11', 'delivered'],
        ['2026-03-12T07:48:02', 'Out for delivery.', 'Sampletown DO', '08', 'out_for_delivery'],
        // The scan listed twice is kept once.
        ['2026-03-11T22:47:00', 'On the way.', 'Example Parcel Hub', '04', 'in_transit'],
        // A place holding a number may be a street.
        ['2026-03-11T06:12:00', 'On the way.', null, '04', 'in_transit'],
        ['2026-03-10T10:46:00', 'Cleared customs.', 'Testport, GB', '03', 'in_transit'],
        ['2026-03-10T10:45:00', 'Customs inspection in progress.', 'Testport, GB', '02', 'customs'],
        ['2026-03-10T06:30:43', 'Arrived at airport.', 'XYZ, GB', '914', 'in_transit'],
        ['2026-03-09T16:49:23', 'Departed airport.', 'Chicago, US', '915', 'in_transit'],
        // The handoff notice names the partner's number, as the page does, and moves nothing.
        ['2026-03-09T15:00:00', `Your order was handed to the local carrier as ${PARTNER}.`, null, '340', null],
        ['2026-03-09T14:23:42Z', 'Departed APC facility, on the way.', 'Elk Grove, IL', '912', 'in_transit'],
        ['2026-03-09T14:13:38Z', 'Order processed and ready for export at APC.', 'Elk Grove, IL', '911', 'in_transit'],
        ['2026-03-09T10:42:53Z', 'Arrived at APC.', 'Elk Grove, IL', '50', 'accepted'],
        // A label's place can be the sender's.
        ['2026-03-02T17:31:34Z', 'Label created.', null, 'DR', 'registered'],
      ]);
    expect(result.events!.filter((event) => event.time).map((event) => event.provider_code)).toEqual(['912', '911', '50', 'DR']);
    expect(result.events!.every((event) => !('time' in event && 'local_time' in event))).toBe(true);
  });

  it('keeps no person, address, postcode, reference, partner note, link or flag', () => {
    const text = JSON.stringify(parseApcPostalLogistics(parcel('delivered'), DELIVERED)) + JSON.stringify(parseApcPostalLogistics(parcel('in-transit'), TRANSIT));
    for (const kept of ['Dana', 'Example Street', 'Sampletown,', 'XX0', 'X0X', 'SAMPLE-SHOP', 'Item received', 'Synthetic partner note', 'royalmail.com',
      'example.com', 'Unit 4', 'Sendertown', 'Sample Lane', 'PRIUDC', 'PRIPDC', 'isDutyPaid', '05:31:34 PM', 'Ready for Export', '{TRACK_NUMBER}']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('reads a parcel before the handoff, keeps a partner’s own offset and leaves an unknown code to the shared rules', () => {
    const result = parseApcPostalLogistics(parcel('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic status.',
      last_update: null, last_update_local: '2026-03-09T08:05:00', expected_delivery_from: '2026-03-12', expected_delivery: '2026-03-16',
      service_name: 'APC Priority DDP w/ DC', destination_country: 'CA' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        ['2026-03-09T08:05:00', 'Synthetic status.', 'Example Depot', '998', null],
        // An unknown code worded as an attempt can be at the recipient's address.
        ['2026-03-09T07:40:00', 'Delivery attempted, recipient not available.', null, '997', null],
        ['2026-03-08T09:15:00-05:00', 'On the way.', 'Exampleville, ON', '01', 'in_transit'],
        ['2026-03-07T14:23:42Z', 'Departed APC facility, on the way.', 'East Rutherford, NJ', '912', 'in_transit'],
        ['2026-03-07T14:13:38Z', 'Order processed and ready for export at APC.', 'East Rutherford, NJ', '911', 'in_transit'],
        ['2026-03-06T11:02:10Z', 'Arrived at APC.', 'East Rutherford, NJ', '50', 'accepted'],
        ['2026-03-04T09:10:00Z', 'Label created.', null, 'DR', 'registered'],
      ]);
    expect(result.events![0]).not.toHaveProperty('stage_source');
    // The page stops showing the estimate once the parcel arrives.
    expect(parseApcPostalLogistics(changed('in-transit', (reply) => { reply.hasArrived = true; }), TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('counts a parcel only when it names the number asked as APC’s own', () => {
    // Before the handoff the parcel can name APC's number only as its package number.
    expect(parseApcPostalLogistics(changed('in-transit', (reply) => { reply.trackingReference2 = null; }), TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    // The merchant's reference alone binds nothing.
    expect(() => parseApcPostalLogistics(changed('delivered', (reply) => { reply.trackingReference1 = DELIVERED; reply.trackingReference2 = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const others: [string, (reply: Parcel) => void][] = [
      ['another APC number', (reply) => { reply.trackingReference2 = '00000P0000000000000009'; }],
      ['a longer APC number', (reply) => { reply.trackingReference2 = `${DELIVERED}9`; }],
      ['no APC number after the handoff', (reply) => { reply.trackingReference2 = null; }],
    ];
    for (const [label, change] of others) {
      expect(() => parseApcPostalLogistics(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseApcPostalLogistics(changed('in-transit', (reply) => { reply.trackingReference2 = '00000A0000000009'; reply.packageNumber = '00000A0000000009'; }), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker opens a parcel by its partner's number too; that is the partner's shipment, whatever its shape.
    const partner = '0000000000000007';
    const handedOver = changed('delivered', (reply) => { reply.packageNumber = partner; reply.carrierTrackingNumber = partner; });
    expect(() => parseApcPostalLogistics(handedOver, partner)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('partner') }));
    for (const change of [(reply: Parcel) => { reply.trackingReference2 = 1; }, (reply: Parcel) => { reply.packageNumber = { id: DELIVERED }; }]) {
      expect(() => parseApcPostalLogistics(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a partner number that is APC’s own, or not a number, out of the result', () => {
    expect(parseApcPostalLogistics(changed('delivered', (reply) => { reply.carrierTrackingNumber = DELIVERED; reply.packageNumber = DELIVERED; }), DELIVERED))
      .not.toHaveProperty('delivery_tracking_number');
    expect(parseApcPostalLogistics(changed('delivered', (reply) => { reply.carrierTrackingNumber = 'n/a'; }), DELIVERED))
      .not.toHaveProperty('delivery_tracking_number');
    expect(parseApcPostalLogistics(changed('delivered', (reply) => { reply.finalMileCarrier = 'Untracked'; reply.externalTrackingUrl = null; }), DELIVERED))
      .not.toHaveProperty('delivery_carrier');
  });

  it('reads a parcel without scans as no history yet, not as found or missing', () => {
    expect(() => parseApcPostalLogistics(changed('in-transit', (reply) => { reply.events = []; }), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    const broken: [string, (reply: Parcel) => void][] = [
      ['no clock', (reply) => { delete reply.events[0]!.eventDateTimeISOFormat; }],
      ['a clock without an offset', (reply) => { reply.events[0]!.eventDateTimeISOFormat = '2026-03-12T13:30:43'; }],
      ['an impossible day', (reply) => { reply.events[0]!.eventDateTimeISOFormat = '2026-02-30T13:30:43+00:00'; }],
      ['the printed clock only', (reply) => { reply.events[0]!.eventDateTimeISOFormat = reply.events[0]!.date; }],
      ['no description', (reply) => { reply.events[0]!.description = ' '; }],
      ['a description that is not text', (reply) => { reply.events[0]!.description = { en: 'Delivered.' }; }],
      ['a code that is not a code', (reply) => { reply.events[0]!.code = 'Delivered to the door'; }],
      ['a scan that is not a record', (reply) => { reply.events[0] = 'Delivered.' as unknown as Row; }],
      ['scans that are not a list', (reply) => { reply.events = {} as unknown as Row[]; }],
      ['no scans at all', (reply) => { delete (reply as Row).events; }],
      ['too many scans', (reply) => { reply.events = Array.from({ length: 501 }, () => reply.events[0]!); }],
    ];
    for (const [label, change] of broken) {
      expect(() => parseApcPostalLogistics(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [[], {}, null, DELIVERED, [parcel('delivered')], JSON.parse(fixture('not-found'))]) {
      expect(() => parseApcPostalLogistics(payload, DELIVERED), JSON.stringify(payload).slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('never reads the lookup’s HTTP 500 as not found, and keeps a bot check, a moved route and a broken reply apart', async () => {
    // The lookup answers numbers it does not have and lookups that fail alike.
    await expect(lookup(reply(fixture('not-found'), { status: 500 }), UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500, message: expect.stringContaining('nothing it could show') });
    await expect(lookup(html('<html><title>500</title></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><body><div class="g-recaptcha"></div></body></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A 404 is a moved route, whatever it says; so is a refusal of the request.
    await expect(lookup(reply('{"error":true,"statusCode":404,"statusMessage":"Page not found"}', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('{"error":true,"statusCode":400,"statusMessage":"Missing id"}', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    // The page itself, with its not-found screen, is no reply of the lookup.
    for (const body of ['', '<html><title>Track a Package - APC Postal Logistics</title><div id="__nuxt"></div></html>', '{}', 'null', '[]']) {
      await expect(lookup(html(body)), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = answering(() => new Response('{}', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('does not ask again after the lookup’s HTTP 500', async () => {
    const fetcher = answering(() => reply(fixture('not-found'), { status: 500 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends a read that did not reach APC once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup(reply('{}', { headers: { 'Content-Length': String(3_000_000) } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers APC does not issue, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000P000000000000000', '00000P00000000000000001', '00000X0000000000000001', '00000A00000000', '00000A00000000001',
      '000000000000000', '00000000000000001', 'PF0000000000000', '0000000000', '', `00000P${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeApcNumber('00000p 0000-0000 0000 0001')).toBe(DELIVERED);
    expect(normalizeApcNumber('0000 0000 0000 0003')).toBe('0000000000000003');
    expect(normalizeApcNumber('00000a000000002')).toBe('00000A000000002');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('ends with the caller’s reason, without a retry, when the caller cancels', async () => {
    const fetcher = hanging();
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('caller cancelled')) }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = createTracker({ fetcher, providers: [], env: {} })
      .track({ number: TRANSIT, carrier: 'apc-postal-logistics' }, { signal: controller.signal, budgetMs: 2000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number detection gives APC to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith(APC_API) ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'apc-postal-logistics', source: 'apc-postal-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${APC_API}${DELIVERED}`)).toBe(true);
  });

  it('declares no recognition: the lookup cannot tell a number it lacks from a failure', () => {
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

describe('APC Postal Logistics numbers', () => {
  it('accepts every number the lookup confirms, and leaves sixteen digits to detection’s other candidates', () => {
    const confirmed = numbers.records.filter((record) => record.context.assessment === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    for (const record of confirmed) {
      expect(normalizeApcNumber(record.number), record.number).toBe(record.number);
      const match = detectCarrierMatch(record.number);
      if (/^\d{16}$/.test(record.number)) {
        expect(match.carrier, record.number).not.toBe('apc-postal-logistics');
        expect(recognitionCandidates(record.number), record.number).not.toContain('apc-postal-logistics');
      } else {
        expect(match, record.number).toMatchObject({ carrier: 'apc-postal-logistics', confidence: 'high' });
        // A high-confidence rule needs no recognition to settle the carrier.
        expect(recognitionCandidates(record.number), record.number).toEqual([]);
      }
      expect(parseTrackingInput(`https://tracking.apc-pli.com/${record.number}`), record.number)
        .toMatchObject({ trackingNumber: record.number, carrier: 'apc-postal-logistics' });
    }
  });
});

describe('APC Postal Logistics status vocabulary', () => {
  it('records every code with the stage the map gives it', () => {
    expect(statuses.entries.filter((entry) => entry.confirmedBy === 'live')).toHaveLength(23);
    for (const entry of statuses.entries) {
      expect(apcStage(entry.code), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'apc-postal-logistics', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('leaves the handoff notice out on purpose and an unknown code unknown', () => {
    expect(statusMapAnswer({ carrier: 'apc-postal-logistics', providerCode: 'dr', description: 'Label created.' })).toEqual({ kind: 'mapped', stage: 'registered' });
    for (const gap of statusMap.gaps) {
      expect(apcStage(gap.code!), gap.code).toBeUndefined();
      expect(statusMapAnswer({ carrier: 'apc-postal-logistics', providerCode: gap.code!, description: 'Any wording' }), gap.code)
        .toEqual({ kind: 'intentional_gap', note: gap.note });
    }
    expect(statusMapAnswer({ carrier: 'apc-postal-logistics', providerCode: '998', description: 'Synthetic status.' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'apc-postal-logistics', providerCode: null, description: 'Delivered.' })).toEqual({ kind: 'unknown' });
  });
});
