import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, lietuvosPastasUrl, LietuvosPastasTracker } from './adapter.js';
import { parseLietuvosPastas } from './parser.js';
import { lietuvosPastasCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// LP Express's own number, without a valid S10 check digit.
const LOCKER = 'CC900000006LT';
const ABROAD = 'RR900000053LT';
// LP Express's own number with a valid S10 check digit.
const RETURNED = 'HC900000019LT';
const NO_HISTORY = 'LI900000036LT';
const UNKNOWN = 'CC900000023LT';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { publicEventType: string; publicEventText: string; eventDate: string; countryCode: string; location?: string; [key: string]: unknown }
interface Mail { mailBarcode: string; type: string; events: Row[]; [key: string]: unknown }
interface Payload { mailGuid: string; mailBarcode: string; mails: Mail[] }
const edited = (name: string, change: (payload: Payload, rows: Row[]) => void = () => {}): Payload => {
  const payload = JSON.parse(text(name)) as Payload;
  change(payload, payload.mails[0]!.events);
  return payload;
};
const rows = (result: ReturnType<typeof parseLietuvosPastas>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.stage_source ?? null, event.location ?? null]);

describe('Lietuvos paštas tracking adapter', () => {
  it('asks the self-service API for the whole number in English once and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('locker')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LietuvosPastasTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cc 900 000 006 lt ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api-esavitarna.post.lt/v2/tracking/${LOCKER}/events`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lietuvos-pastas', step: 'direct', outcome: 'ok' }));
  });

  it('orders a parcel collected from a locker newest first, keeps Vilnius offsets and leaves streets and postcodes out', () => {
    const result = parseLietuvosPastas(JSON.parse(text('locker')), LOCKER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has been delivered to the recipient', last_update: '2026-02-04T17:45:00+02:00',
      expected_delivery: null, delivered_at: '2026-02-04T17:45:00+02:00', pickup_point: '9002 paštomatas, Sample Store\nSample City' });
    expect(result.history_truncated).toBeUndefined();
    expect(result.last_update_local).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-02-04T17:45:00+02:00', 'DELIVERY_DELIVERED', 'delivered', 'carrier_map', '9002 paštomatas, Sample Store, Sample City'],
      // A message to the recipient keeps the stage of the row before it.
      ['2026-02-03T12:00:30+02:00', 'NOTIFICATIONS_INFORMED', 'ready_for_pickup', 'none', null],
      ['2026-02-03T12:00:00+02:00', 'RECEIVED_TERMINAL', 'ready_for_pickup', 'carrier_map', '9002 paštomatas, Sample Store, Sample City'],
      ['2026-02-03T06:50:00+02:00', 'TRANSFERRED_FOR_DELIVERY_COURIER', 'out_for_delivery', 'carrier_map', null],
      ['2026-02-03T05:40:00+02:00', 'RECEIVED_LC', 'in_transit', 'carrier_map', 'Kaunas'],
      ['2026-02-02T22:30:05+02:00', 'DELIVERY_TRANSFER', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-02-02T22:30:00+02:00', 'RECEIVED_LC', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-02-02T18:20:00+02:00', 'RECEIVED_TERMINAL_OUT', 'in_transit', 'carrier_map', '9001 paštomatas, Example Market, Example Town'],
      ['2026-02-02T15:10:00+02:00', 'ACCEPTED_TERMINAL', 'accepted', 'carrier_map', '9001 paštomatas, Example Market, Example Town'],
      // A fraction of a second is dropped, and the self-service site is not a place.
      ['2026-02-02T09:00:11+02:00', 'LABEL_CREATED', 'registered', 'carrier_map', null],
    ]);
    expect(result.events![0]!.description).toBe('The parcel has been delivered to the recipient');
    const kept = JSON.stringify(result);
    for (const dropped of ['Sample g. 1', 'Example g. 2A', '00001', '00002', 'Savitarna', '9a000000', 'Label created']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('names the locker a parcel waits in while it waits there', () => {
    const result = parseLietuvosPastas(edited('locker', (_payload, events) => { events.pop(); }), LOCKER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: '9002 paštomatas, Sample Store\nSample City',
      last_status_text: 'The parcel was delivered to the UNISEND parcel locker', last_update: '2026-02-03T12:00:30+02:00' });
    expect(result.delivered_at).toBeUndefined();
    // Brought to the door: no pickup point.
    const door = parseLietuvosPastas(edited('locker', (_payload, events) => { events.splice(7, 2); delete events.at(-1)!.location; }), LOCKER);
    expect(door).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-02-04T17:45:00+02:00' });
    expect(door.pickup_point).toBeUndefined();
  });

  it('reads a row from abroad as that country’s wall clock, and names the country in English', () => {
    const result = parseLietuvosPastas(JSON.parse(text('abroad')), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-07-03T19:20:00+02:00',
      last_status_text: 'The parcel is sent from the distribution center of the recipient\'s (or transit) country', destination_country: 'SI' });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-07-03T19:20:00+02:00', 'DEPARTED_RECEIVER_LC', 'in_transit', 'carrier_map', 'Slovenia'],
      ['2026-07-03T19:20:00+02:00', 'RECEIVED_RECEIVER_LC', 'in_transit', 'carrier_map', 'Slovenia'],
      ['2026-07-02T13:40:00+03:00', 'DELIVERY_EXPORTED', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-07-02T01:15:00+03:00', 'RECEIVED_LC', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-07-01T14:05:30+03:00', 'ACCEPTED', 'accepted', 'carrier_map', 'Example Town 1-asis paštas, Example Town'],
      ['2026-07-01T10:00:00+03:00', 'LABEL_CREATED', 'registered', 'carrier_map', null],
    ]);
    // A country with several zones keeps the wall clock; a neighbour on Vilnius time keeps the instant.
    const wide = parseLietuvosPastas(edited('abroad', (_payload, events) => {
      for (const row of events.slice(4)) Object.assign(row, { countryCode: 'US', location: 'Jungtinės Valstijos' });
    }), ABROAD);
    expect(wide).toMatchObject({ last_update: null, last_update_local: '2026-07-03T19:20:00' });
    expect(rows(wide).slice(0, 3)).toEqual([
      ['2026-07-03T19:20:00', 'DEPARTED_RECEIVER_LC', 'in_transit', 'carrier_map', 'United States'],
      ['2026-07-03T19:20:00', 'RECEIVED_RECEIVER_LC', 'in_transit', 'carrier_map', 'United States'],
      ['2026-07-02T13:40:00+03:00', 'DELIVERY_EXPORTED', 'in_transit', 'carrier_map', 'Vilnius'],
    ]);
    const near = parseLietuvosPastas(edited('abroad', (_payload, events) => {
      for (const row of events.slice(4)) Object.assign(row, { countryCode: 'LV', location: 'Rīga' });
    }), ABROAD);
    expect(rows(near)[0]).toEqual(['2026-07-03T19:20:00+03:00', 'DEPARTED_RECEIVER_LC', 'in_transit', 'carrier_map', 'Rīga']);
  });

  it('names the country an item sent abroad reached last, whose post is asked for the rest', () => {
    // A transit country's centre comes before the recipient's.
    const reached = parseLietuvosPastas(edited('abroad', (_payload, events) => {
      Object.assign(events[4]!, { countryCode: 'DE', location: 'Vokietija' });
      Object.assign(events[5]!, { publicEventType: 'RECEIVED_RECEIVER_LC', eventDate: '2026-07-05T09:00:00+03:00', countryCode: 'GB', location: 'Jungtinė Karalystė' });
    }), ABROAD);
    expect(reached.destination_country).toBe('GB');
    expect(deliveryHandoff('lietuvos-pastas', ABROAD, reached, 'PL')).toEqual({ carrier: 'royal-mail', number: ABROAD, basis: 'destination' });
    // Until then the export names no country, and the country the item is looked up from stands in.
    const exported = parseLietuvosPastas(edited('abroad', (_payload, events) => { events.splice(4); }), ABROAD);
    expect(exported.destination_country).toBeUndefined();
    expect(deliveryHandoff('lietuvos-pastas', ABROAD, exported, 'PL')).toEqual({ carrier: 'poczta-polska', number: ABROAD, basis: 'destination' });
  });

  it('reads a parcel sent back as returned, without the return label’s mail, a pickup point or a door address', () => {
    const result = parseLietuvosPastas(JSON.parse(text('returned')), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_update: '2026-03-23T11:00:00+02:00' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-23T11:00:00+02:00', 'DELIVERY_DELIVERED', 'returned', 'carrier_map', 'Example Town 1-asis paštas, Example Town'],
      ['2026-03-21T03:00:00+02:00', 'RECEIVED_LC', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-03-20T09:00:00+02:00', 'DELIVERY_RETURNED', 'exception', 'carrier_map', 'Sample City paštas, Sample City'],
      ['2026-03-03T15:00:00+02:00', 'RECEIVED_DELIVERY_POST', 'in_transit', 'carrier_map', 'Sample City paštas, Sample City'],
      ['2026-03-03T13:00:00+02:00', 'DELIVERY_UNSUCCESSFUL_DELIVERY', 'failed_attempt', 'carrier_map', null],
      ['2026-03-03T08:00:00+02:00', 'TRANSFERRED_FOR_DELIVERY_POSTMAN', 'out_for_delivery', 'carrier_map', null],
      ['2026-03-03T02:00:00+02:00', 'RECEIVED_LC', 'in_transit', 'carrier_map', 'Vilnius'],
      ['2026-03-02T16:00:00+02:00', 'ACCEPTED', 'accepted', 'carrier_map', 'Example Town 1-asis paštas, Example Town'],
      ['2026-03-02T08:00:00+02:00', 'LABEL_CREATED', 'registered', 'carrier_map', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Example g\. 9-9|Market g\. 5|Sample g\. 3|0000[23]|CC900000019LT|2026-03-24/);
  });

  it('keeps new and unclear types visible, staged by their wording when it says enough, drops repeated rows and caps long histories', () => {
    const result = parseLietuvosPastas(edited('locker', (_payload, events) => {
      events.push({ ...events[0]!, publicEventType: 'DELIVERY_STORING', publicEventText: 'The parcel is stored', eventDate: '2026-02-05T09:00:00+02:00' },
        { ...events[0]!, publicEventType: 'SOMETHING_NEW', publicEventText: '', eventDate: '2026-02-06T09:00:00+02:00' },
        { ...events[0]!, publicEventType: 'DELIVERY_HOLDING', publicEventText: 'Return to sender', eventDate: '2026-02-07T09:00:00+02:00' },
        { ...events[9]! });
    }), LOCKER);
    // The shared rules read a return to the sender as one under way.
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'wording:language' });
    expect(result.events!.slice(0, 3)).toEqual([
      { time: '2026-02-07T09:00:00+02:00', description: 'Return to sender', provider_code: 'DELIVERY_HOLDING', stage: 'exception', stage_source: 'wording:language' },
      { time: '2026-02-06T09:00:00+02:00', description: 'SOMETHING_NEW', provider_code: 'SOMETHING_NEW' },
      { time: '2026-02-05T09:00:00+02:00', description: 'The parcel is stored', provider_code: 'DELIVERY_STORING' },
    ]);
    expect(result.events!.filter(event => event.provider_code === 'DELIVERY_DELIVERED')).toHaveLength(1);
    const long = parseLietuvosPastas(edited('locker', (_payload, events) => {
      events.unshift(...Array.from({ length: 120 }, (_, index) => ({ ...events[3]!, publicEventText: `The parcel is at the distribution center ${index}` })));
    }), LOCKER);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('reads the empty mail as a missing parcel, and a known mail without rows as inconclusive', async () => {
    expect(() => parseLietuvosPastas(JSON.parse(text('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLietuvosPastas(JSON.parse(text('no-history')), NO_HISTORY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A mail whose only rows are its return label's has none of its own.
    const labelOnly = edited('returned', payload => { payload.mails.shift(); });
    expect(() => parseLietuvosPastas(labelOnly, RETURNED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('locker'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('no-history')));
    await expect(carrier(fetcher).recognize!(LOCKER)).resolves.toEqual({ known: true, lastActivityAt: '2026-02-04T15:45:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(NO_HISTORY)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds the answer to the whole requested number and rejects malformed mails', () => {
    expect(() => parseLietuvosPastas(JSON.parse(text('locker')), 'CC900000007LT')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLietuvosPastas(JSON.parse(text('not-found')), 'CC900000024LT')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (payload: Payload) => { delete (payload as Partial<Payload>).mailBarcode; },
      (payload: Payload) => { payload.mailGuid = 'not a guid'; },
      (payload: Payload) => { (payload as { mails: unknown }).mails = {}; },
      (payload: Payload) => { (payload.mails as unknown[])[0] = 'mail'; },
      (payload: Payload) => { payload.mailGuid = '00000000-0000-0000-0000-000000000000'; },
      (_payload: Payload, events: Row[]) => { events[0]!.eventDate = '2026-02-30T09:00:00+02:00'; },
      (_payload: Payload, events: Row[]) => { events[0]!.eventDate = '2026-02-02 09:00:00'; },
      (_payload: Payload, events: Row[]) => { events[0]!.publicEventType = 'not a type'; },
      (_payload: Payload, events: Row[]) => { (events as unknown[])[0] = 'row'; },
    ]) expect(() => parseLietuvosPastas(edited('locker', change), LOCKER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'mail', {}, JSON.parse(text('locker')).mails[0].events]) {
      expect(() => parseLietuvosPastas(payload, LOCKER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: LOCKER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(LOCKER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 0000</body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['{"items":[]}', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      await expect(carrier(fetcher).recognize!(LOCKER), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: LOCKER })).rejects.toThrow('unexpectedly large');
  });

  it('takes item codes ending LT and S10 codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR900000054DE', 'CC90000000LT', 'CC9000000060LT', 'C9900000006LT', 'LP000000000000001', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const number = decodeURIComponent(String(url).split('/').at(-2)!);
      return reply(JSON.stringify({ ...JSON.parse(text('not-found')), mailBarcode: number }));
    });
    for (const number of ['RR900000019DE', 'RR900000054LT', UNKNOWN]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => String(url))).toEqual(['RR900000019DE', 'RR900000054LT', UNKNOWN].map(lietuvosPastasUrl));
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('locker')));
    await expect(carrier(flaky).track({ number: LOCKER })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('locker')));
    await expect(carrier(immediate).track({ number: LOCKER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: LOCKER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: LOCKER }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Lietuvos paštas to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('returned')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'lietuvos-pastas' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'lietuvos-pastas', source: 'lietuvos-pastas', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === lietuvosPastasUrl(RETURNED))).toBe(true);
  });

  it('is named for its own parcels, EMS items and LP Express parcels, offered for LP Express numbers and asked about its other S10 codes', () => {
    // Its tracker relays a parcel's arrival and customs abroad; PostPlus sends L series items under its code.
    for (const number of ['CE900000019LT', 'EB900000019LT', 'CC900000019LT', RETURNED]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'lietuvos-pastas', confidence: 'high', candidates: ['lietuvos-pastas'] });
      expect(recognitionAskedCarriers(number), number).toEqual([]);
    }
    expect(detectCarrierMatch('CE900000018LT').candidates).not.toContain('lietuvos-pastas');
    expect(detectCarrierMatch('CE900000019LV').candidates).not.toContain('lietuvos-pastas');
    expect(detectCarrierMatch(LOCKER)).toMatchObject({ carrier: 'unknown', candidates: expect.arrayContaining(['lietuvos-pastas']) });
    expect(recognitionAskedCarriers(LOCKER)).toContain('lietuvos-pastas');
    expect(detectCarrierMatch('HC900000018LT')).toMatchObject({ carrier: 'unknown', candidates: ['lietuvos-pastas'] });
    expect(detectCarrierMatch('HA900000019LT')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    for (const number of [ABROAD, NO_HISTORY]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).toContain('lietuvos-pastas');
    }
    expect(recognitionAskedCarriers('RR900000054LT')).not.toContain('lietuvos-pastas');
    expect(recognitionAskedCarriers('RR900000019DE')).not.toContain('lietuvos-pastas');
    expect(parseTrackingInput(`https://lpexpress.lt/track?parcel=${LOCKER}`))
      .toMatchObject({ trackingNumber: LOCKER, carrier: 'lietuvos-pastas', source: 'link' });
  });
});

describe('Lietuvos paštas status vocabulary', () => {
  it('records every type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(lietuvosPastasCodeStage(entry.code), entry.code).toBe(stage);
      if (stage) expect(statusMap.stage(entry.code, (('wording' in entry ? entry.wording : undefined) ?? '').toLowerCase()), entry.code).toBe(stage);
    }
    for (const code of ['constructor', 'toString', '__proto__']) expect(lietuvosPastasCodeStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'the parcel has been delivered to the recipient')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'lietuvos-pastas', providerCode: 'RECEIVED_TERMINAL', description: 'The parcel was delivered to the UNISEND parcel locker' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    for (const code of ['NOTIFICATIONS_INFORMED', 'ORDERS_PARCEL_DEMAND', 'DELIVERY_STORING', 'DELIVERY_EDF']) {
      expect(statusMapAnswer({ carrier: 'lietuvos-pastas', providerCode: code, description: 'Any wording' }), code).toMatchObject({ kind: 'intentional_gap' });
    }
    // A type the map leaves open takes a stage from wording that says enough, as the parser does.
    expect(statusMapAnswer({ carrier: 'lietuvos-pastas', providerCode: 'DELIVERY_HOLDING', description: 'Return to sender' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
  });
});
