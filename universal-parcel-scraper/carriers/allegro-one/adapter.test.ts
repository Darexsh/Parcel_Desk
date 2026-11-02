import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ALLEGRO_ONE_ENDPOINT, AllegroOneTracker } from './adapter.js';
import { normalizeAllegroOneNumber, parseAllegroOne } from './parser.js';
import { ALLEGRO_ONE_POLISH, allegroOneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'A0ZZ000001';
const READY = 'A0ZZ000002';
const RETURNED = 'A0ZZ000003';
const TRANSIT = 'A0ZZ000004';
const DELIVERY = 'ADZZ000001';
const PARTNER = 'AD0ZZZZZZZZZZ0001';
const SENT_BACK = 'AD0ZZZZZZZZZZ0002';
const OLDER = 'ALE900000000001';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): { status: Record<string, unknown>[] } => JSON.parse(text(name));
const MEDIA_TYPE = 'application/vnd.allegro.internal.v1+json';
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': MEDIA_TYPE } });
const empty = () => reply('{"status":[]}');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Allegro One HTTP adapter', () => {
  it('asks the edge service once for the whole number, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AllegroOneTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' a0zz-000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://edge.allegro.pl/ad/tracking?packageNo=${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: MEDIA_TYPE, 'Accept-Language': 'en-US', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'allegro-one', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for Polish for a Polish reader and for English for anyone else', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(text('delivered')));
    const instance = carrier(fetcher);
    for (const [language, asked] of [['pl', 'pl-PL'], ['pl-PL', 'pl-PL'], ['de', 'en-US'], [null, 'en-US']] as const) {
      await instance.track({ number: DELIVERED, language });
      expect((fetcher.mock.calls.at(-1)?.[1]?.headers as Record<string, string>)['Accept-Language']).toBe(asked);
    }
  });

  it('reads a reply in Polish as it reads the same reply in English', () => {
    const polish = new Map(Object.entries(ALLEGRO_ONE_POLISH).map(([wording, english]) => [english, wording]));
    for (const [name, number] of [['delivered', DELIVERED], ['ready', READY], ['returned', RETURNED], ['in-transit', TRANSIT],
      ['delivery', DELIVERY], ['sent-back', SENT_BACK]] as const) {
      const english = fixture(name);
      const translated = { status: english.status.map((row) => ({ ...row, description: polish.get(String(row.description)) })) };
      expect(translated.status.every((row) => row.description), name).toBe(true);
      const read = (reply: unknown) => {
        const result = parseAllegroOne(reply, number);
        return { ...result, last_status_text: undefined, events: result.events!.map((event) => ({ ...event, description: undefined })) };
      };
      expect(read(translated), name).toEqual(read(english));
    }
  });

  it('lets a scan worded in the other language take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('allegro-one', { supportsScanMatching: true });
    const english = { stage: 'ready_for_pickup', description: 'Parcel is awaiting pick-up', location: '', providerCode: '' };
    const polish = { ...english, description: 'Przesyłka oczekuje na odbiór' };
    expect(policy).toMatchObject({ storedSources: ['allegro-one'], requireProviderCode: false, matchEachScan: true });
    expect(policy?.matches?.(polish, english)).toBe(true);
    expect(policy?.matches?.(english, polish)).toBe(true);
    expect(policy?.matches?.({ ...polish, description: 'Czas na odbiór został przedłużony' }, english)).toBe(false);
    expect(policy?.matches?.(polish, { ...english, description: 'Time for pick-up has been extended' })).toBe(false);
  });

  it('reads a delivered parcel newest first and drops a repeated scan', () => {
    const result = parseAllegroOne(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: '2026-09-24T14:05:12Z', delivered_at: '2026-09-24T14:05:12Z',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-09-24T14:05:12Z', 'delivered'],
      ['2026-09-24T10:31:40.120Z', 'ready_for_pickup'],
      ['2026-09-24T06:12:03Z', 'out_for_delivery'],
      ['2026-09-23T19:44:27Z', 'failed_attempt'],
      ['2026-09-23T06:02:51Z', 'out_for_delivery'],
      ['2026-09-23T03:15:09.481Z', 'in_transit'],
      ['2026-09-22T22:40:18.902Z', 'in_transit'],
      ['2026-09-22T17:21:36Z', 'in_transit'],
      ['2026-09-22T13:08:44Z', 'accepted'],
      ['2026-09-21T09:30:00.250Z', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    expect(result.history_truncated).toBeUndefined();
  });

  it('reads a parcel waiting at its point and a parcel sent back', () => {
    expect(parseAllegroOne(fixture('ready'), READY)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Time for pick-up has been extended', last_update: '2026-10-02T11:20:07.345Z' });
    expect(parseAllegroOne(fixture('ready'), READY).delivered_at).toBeUndefined();
    const returned = parseAllegroOne(fixture('returned'), RETURNED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Parcel has been returned to the sender' });
    expect(returned.events!.map((event) => event.stage)).toEqual(['returned', 'exception', 'ready_for_pickup', 'ready_for_pickup',
      'out_for_delivery', 'in_transit', 'accepted', 'accepted', 'registered']);
  });

  it('reads a newer parcel, listed oldest first, with its sorting-centre scans', () => {
    const result = parseAllegroOne(fixture('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been accepted at the branch', last_update: '2026-10-06T04:52:36.512Z' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => event.description)).toEqual(fixture('in-transit').status.map((row) => row.description).reverse());
    expect(result.events![3]).toEqual({ time: '2026-10-05T21:30:05.777Z', description: 'Dispatched from sorting center',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads an Allegro Delivery parcel under its seventeen-character number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivery')));
    const result = await carrier(fetcher).track({ number: 'ad0z-zzzz-zzzz-z0001' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${ALLEGRO_ONE_ENDPOINT}?packageNo=${PARTNER}`);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel has been delivered',
      delivered_at: '2026-10-01T15:55:02Z' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Parcel has been delivered', 'delivered'],
      ['Parcel is awaiting pick-up', 'ready_for_pickup'],
      ['Parcel has been accepted at the branch', 'in_transit'],
      ['Notice', 'failed_attempt'],
      ['Parcel has been released for delivery', 'out_for_delivery'],
      ['Parcel has been accepted at the destination center', 'in_transit'],
      ['Parcel has been accepted at the delivery center', 'in_transit'],
      ['Parcel has been picked up from point by courier', 'accepted'],
      ['Parcel has been dispatched at point', 'accepted'],
      ['Parcel has been prepared by the sender', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a courier collecting the parcel after it waited at its point as the parcel taken back', () => {
    const payload = fixture('ready');
    payload.status.unshift({ eventTimestamp: '2026-10-08T10:04:51Z', description: 'Parcel has been picked up from point by courier' });
    expect(parseAllegroOne(payload, READY)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Parcel has been picked up from point by courier' });
    payload.status.unshift(
      { eventTimestamp: '2026-10-09T09:40:18Z', description: 'Parcel is awaiting pick-up' },
      { eventTimestamp: '2026-10-09T06:02:44Z', description: 'Parcel has been released for delivery' },
      { eventTimestamp: '2026-10-08T15:20:06Z', description: 'Parcel has been picked up by the courier' },
      { eventTimestamp: '2026-10-08T15:20:05Z', description: 'Courier has transferred the parcel to the warehouse' },
    );
    const result = parseAllegroOne(payload, READY);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Parcel is awaiting pick-up' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Parcel is awaiting pick-up', 'ready_for_pickup'],
      ['Parcel has been released for delivery', 'out_for_delivery'],
      ['Parcel has been picked up by the courier', 'in_transit'],
      ['Courier has transferred the parcel to the warehouse', 'in_transit'],
      ['Parcel has been picked up from point by courier', 'in_transit'],
      ['Time for pick-up has been extended', 'ready_for_pickup'],
      ['Parcel is awaiting pick-up', 'ready_for_pickup'],
      ['Parcel has been released for delivery', 'out_for_delivery'],
      ['Parcel delivery time has been arranged with the recipient', 'in_transit'],
      ['Parcel has been redirected to a different point', 'in_transit'],
      ['Parcel is waiting for an alternative point indication', 'exception'],
      ['Parcel has been accepted at the branch', 'in_transit'],
      ['Parcel may be delivered with delay', 'in_transit'],
      ['Parcel has been dispatched at point', 'accepted'],
      ['Parcel has been prepared by the sender', 'registered'],
    ]);
  });

  it('reads a parcel taken back once its pick-up time expired as a return under way, unless it goes to a point again', () => {
    const payload = fixture('ready');
    payload.status.unshift(
      { eventTimestamp: '2026-10-08T10:04:51Z', description: 'Parcel has been picked up from point by courier' },
      { eventTimestamp: '2026-10-07T18:00:12Z', description: 'Time for parcel pick-up has expired' },
    );
    expect(parseAllegroOne(payload, READY)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Parcel has been picked up from point by courier' });
    const back = structuredClone(payload);
    back.status.unshift({ eventTimestamp: '2026-10-09T08:12:40Z', description: 'Parcel has been returned to the sender' });
    expect(parseAllegroOne(back, READY).events!.slice(0, 3).map((event) => event.stage)).toEqual(['returned', 'exception', 'exception']);
    payload.status.unshift(
      { eventTimestamp: '2026-10-09T09:40:18Z', description: 'Parcel is awaiting pick-up' },
      { eventTimestamp: '2026-10-09T04:22:15Z', description: 'Parcel has been accepted at the branch' },
    );
    expect(parseAllegroOne(payload, READY).events!.slice(0, 4).map((event) => [event.description, event.stage])).toEqual([
      ['Parcel is awaiting pick-up', 'ready_for_pickup'],
      ['Parcel has been accepted at the branch', 'in_transit'],
      ['Parcel has been picked up from point by courier', 'in_transit'],
      ['Time for parcel pick-up has expired', 'exception'],
    ]);
  });

  it('reads a return to the sender followed by its way back as a return under way until the sender has it', () => {
    const result = parseAllegroOne(fixture('sent-back'), SENT_BACK);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been released for delivery', last_update: '2026-09-28T05:50:33.164Z' });
    expect(result.events!.map((event) => event.stage)).toEqual(['exception', 'exception', 'exception', 'exception', 'exception',
      'failed_attempt', 'out_for_delivery', 'in_transit', 'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted',
      'accepted', 'registered']);
    const back = fixture('sent-back');
    back.status.push({ eventTimestamp: '2026-09-28T12:14:51Z', description: 'Parcel has been delivered' });
    const delivered = parseAllegroOne(back, SENT_BACK);
    expect(delivered).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Parcel has been delivered' });
    expect(delivered.events!.slice(0, 6).map((event) => event.stage))
      .toEqual(['returned', 'exception', 'exception', 'exception', 'exception', 'exception']);
    expect(delivered.delivered_at).toBeUndefined();
    // A later scan that does not move the parcel leaves the return to the sender as it reads.
    const noted = fixture('sent-back').status.slice(0, 11);
    noted.push({ eventTimestamp: '2026-09-25T09:00:00Z', description: 'Parcel has been weighed' });
    expect(parseAllegroOne({ status: noted }, SENT_BACK).events!.slice(0, 2).map((event) => event.stage)).toEqual([undefined, 'returned']);
  });

  it('orders scans by instant, keeps equal ones in the order they were logged and leaves unknown wording to the shared rules', () => {
    const weighed = { eventTimestamp: '2026-10-02T11:20:07.345Z', description: 'Parcel has been weighed' };
    const extended = { time: '2026-10-02T11:20:07.345Z', description: 'Time for pick-up has been extended', stage: 'ready_for_pickup', stage_source: 'carrier_map' };
    const newestFirst = fixture('ready');
    newestFirst.status.splice(1, 0, weighed);
    expect(parseAllegroOne(newestFirst, READY).events!.slice(0, 2)).toEqual([extended, { time: weighed.eventTimestamp, description: weighed.description }]);
    const oldestFirst = fixture('ready');
    oldestFirst.status.reverse();
    oldestFirst.status.push(weighed);
    const result = parseAllegroOne(oldestFirst, READY);
    expect(result.events!.slice(0, 3)).toEqual([
      { time: weighed.eventTimestamp, description: weighed.description },
      extended,
      { time: '2026-10-02T11:19:55Z', description: 'Parcel is awaiting pick-up', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
    ]);
    const unknown = parseAllegroOne({ status: [{ eventTimestamp: '2026-10-03T08:00:00Z', description: 'Parcel has been weighed' }] }, READY);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parcel has been weighed' });
    expect(unknown.current_stage).toBeUndefined();
  });

  it('keeps the newest hundred scans of a long history', () => {
    const status = Array.from({ length: 120 }, (_, index) => ({
      eventTimestamp: new Date(Date.UTC(2026, 8, 1) + (120 - index) * 60_000).toISOString(),
      description: index % 2 ? 'Parcel has been accepted at the branch' : 'Parcel has been released for delivery',
    }));
    const result = parseAllegroOne({ status }, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (payload: { status: Record<string, unknown>[] }) => { payload.status[2]!.eventTimestamp = '2026-09-24 06:12'; },
      (payload: { status: Record<string, unknown>[] }) => { payload.status[2]!.eventTimestamp = '2026-09-24T06:12:03'; },
      (payload: { status: Record<string, unknown>[] }) => { payload.status[2]!.description = ' '; },
      (payload: { status: Record<string, unknown>[] }) => { payload.status[2]!.description = { text: 'Parcel has been delivered' }; },
      (payload: { status: unknown }) => { payload.status = {}; },
    ]) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parseAllegroOne(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [{}, [], { history: [] }, { status: Array.from({ length: 301 }, () => ({})) }]) {
      expect(() => parseAllegroOne(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads an empty list as not found for A0 and AD numbers and as no history for the older form', async () => {
    const lookup = (number: string, body = '{"status":[]}') => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number });
    await expect(lookup(DELIVERED)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(DELIVERED, '{"status":null}')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(DELIVERY)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(PARTNER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(OLDER)).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(lookup(OLDER, text('delivered'))).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps a refused request, a retired route and a redirect apart from a missing parcel', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: DELIVERED });
    await expect(lookup(new Response('{"errors":[{"message":"Bad Request"}]}', { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('{"errors":[{"message":"Feature unavailable. Contact the application author."}]}', { status: 404 })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('', { status: 406 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('', { status: 410 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a bot check and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [
      ['<html><script src="https://ct.captcha-delivery.com/c.js"></script></html>', 'challenge'],
      ['<html>Maintenance</html>', 'schema'],
      ['{"events":[]}', 'schema'],
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a known parcel and the unknown-number answer, and asks nothing for a number Allegro One does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(empty());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-24T14:05:12.000Z' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('A1ZZ000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Allegro One does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['A1ZZ000001', 'A0ZZ00001', 'A0ZZ0000011', 'AEZZ000001', 'ALE90000000001', 'ALE9000000000A1', 'A0ZZ_00001',
      'AD0ZZZZZZZZZZ000', 'AD0ZZZZZZZZZZ00011', 'A0ZZZZZZZZZZZ0001', 'AD900000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAllegroOneNumber('a0zz 0000.01')).toBe(DELIVERED);
    expect(normalizeAllegroOneNumber(OLDER.toLowerCase())).toBe(OLDER);
    expect(normalizeAllegroOneNumber('AD0AEIOUY00000001')).toBe('AD0AEIOUY00000001');
  });

  it('sends a read that failed to reach Allegro once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('ready')));
    await expect(carrier(fetcher).track({ number: READY }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('refuses a reply larger than its byte limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(`{"status":[],"padding":"${'x'.repeat(300 * 1024)}"}`));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
  });

  it('routes a detected number and a pasted tracking link to the adapter', async () => {
    for (const number of [DELIVERED, PARTNER]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'allegro-one', confidence: 'high' });
    }
    // Seventeen-character numbers seen use digits and consonants after AD0.
    expect(detectCarrierMatch('AD0AZZZZZZZZZ0001').carrier).not.toBe('allegro-one');
    for (const link of [`https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=${DELIVERED}`,
      `https://allegro.pl/kampania/one/kurier/sledzenie-paczki?numer=${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'allegro-one', source: 'link' });
    }
    expect(parseTrackingInput(`https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=${PARTNER}`))
      .toMatchObject({ trackingNumber: PARTNER, carrier: 'allegro-one', source: 'link' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'allegro-one' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'allegro-one', source: 'allegro-one', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${ALLEGRO_ONE_ENDPOINT}?packageNo=${DELIVERED}`)).toBe(true);
  });
});

describe('Allegro One status vocabulary', () => {
  it('records every wording the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      expect(allegroOneStage(entry.wording)).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'allegro-one', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statuses.entries).toHaveLength(new Set(statuses.entries.map((entry) => entry.wording)).size);
    expect(statusMapAnswer({ carrier: 'allegro-one', description: 'PARCEL HAS BEEN DELIVERED' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMap.stage('7', 'parcel has been delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'parcel has been weighed')).toBeUndefined();
  });
});
