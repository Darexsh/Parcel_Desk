import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KAZPOST_TRACKING_API, KazpostTracker, kazpostUrls } from './adapter.js';
import { kazpostJson, normalizeKazpostNumber, parseKazpost } from './parser.js';
import { isHiddenKazpostCode, kazpostStage, kazpostUndone, kazpostWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014KZ';
const PICKUP = 'ZZ000000028KZ';
const IN_TRANSIT = 'ZZ000000031KZ';
const SUMMARY_ONLY = 'ZZ000000045KZ';
const UNKNOWN = 'ZZ000000059KZ';
const INBOUND = 'ZZ000000028CN';
type Json = Record<string, unknown>;
type Day = { date: string; activity: Json[] };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as Json;
const replies = (name: string) => [json(`${name}.summary`), json(`${name}.events`)] as const;
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Answers the summary and history routes with the named fixtures.
const serve = (name: string) => vi.fn<typeof fetch>(async (input) => reply(String(input).endsWith('/events')
  ? fixture(name === 'not-found' ? 'not-found' : `${name}.events`) : fixture(name === 'not-found' ? 'not-found' : `${name}.summary`)));
// One scan as the history lists it, at a synthetic office.
const scan = (time: string, code: string, name = 'Отделение Образцово', city = 'Город Образцово, улица Почтовая, дом 4') =>
  ({ time, zip: '000000', city, cityKz: city, name, x_dep_id: '000004/01', status: [code], dep_code: '000004/01',
    nondlv_reason: null, return_reason: null, forward_reason: null });
const history = (number: string, days: Day[]) => ({ trackid: number, events: days, timestamp: '12:00:00 10.02.2026' });
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>';
const SHELL = '<!doctype html><html lang="kk"><head><title>АО «Казпочта»</title></head><body><div id="root"></div></body></html>';

describe('Kazpost tracking adapter', () => {
  it('asks the tracking API for the whole code’s summary and history, through the supplied transport', async () => {
    const fetcher = serve('delivered');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KazpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 kz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${KAZPOST_TRACKING_API}${DELIVERED}`, `${KAZPOST_TRACKING_API}${DELIVERED}/events`]);
    expect(kazpostUrls(DELIVERED)).toEqual({ summary: `${KAZPOST_TRACKING_API}${DELIVERED}`, history: `${KAZPOST_TRACKING_API}${DELIVERED}/events` });
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'Accept-Language': 'ru', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kazpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a courier delivery newest first with each office’s wall clock, without the page’s hidden paperwork or people', () => {
    const result = parseKazpost(...replies('delivered'), DELIVERED);
    const exchange = 'Международный пункт обмена Примерск, Примерская область, город Примерск, улица Образцовая, дом 1';
    const delivery = 'Отделение доставки Образцово, Город Образцово, проспект Тестовый, дом 3';
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручено', last_update: null, last_update_local: '2026-02-03T16:11:19', expected_delivery: null,
      weight_kg: 1.25, destination_country: 'KZ' });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage, event.provider_code])).toEqual([
      // The handover and the courier's delivery at the same second keep the order they were made in.
      ['2026-02-03T16:11:19', delivery, 'Вручено', 'delivered', 'DPAY_I'],
      ['2026-02-03T16:11:19', delivery, 'Доставлено курьером', 'delivered', 'DLV_HAND'],
      ['2026-02-03T09:37:42', delivery, 'Передано почтальону/курьеру на доставку', 'out_for_delivery', 'DLV_I'],
      ['2026-02-03T00:56:38', delivery, 'Прибыло в пункт доставки', 'in_transit', 'STR_EMS'],
      ['2026-02-03T00:40:12', delivery, 'Прибыло в центр сортировки', 'in_transit', 'PRC'],
      ['2026-02-02T11:18:27', exchange, 'Отправлено из центра сортировки', 'in_transit', 'SND'],
      ['2026-02-02T05:55:11', exchange, 'Прошло таможенное оформление', 'in_transit', 'SNDZONE_T'],
      ['2026-02-02T04:47:22', exchange, 'Принято почтовое отправление', 'accepted', 'Registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Тестовый Получатель|Вымышленная|Example Sender|Example Street|\+7 000|000000|Авиа|Обыкновенное/);
  });

  it('names the office an item waits at as its pickup point, also once collected there, and none for an item that moved on', () => {
    const waiting = parseKazpost(...replies('pickup'), PICKUP);
    const office = 'Почтовое отделение Образцово-4\nГород Образцово, улица Почтовая, дом 4';
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: office,
      last_status_text: 'Ожидает получателя в пункте выдачи', last_update_local: '2026-02-06T18:05:00', weight_kg: 0.4 });
    expect(waiting.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['STR', 'ready_for_pickup'], ['NONDLV', 'failed_attempt'], ['DLV', 'out_for_delivery'], ['PRC', 'in_transit'],
      ['SND', 'in_transit'], ['PRC', 'in_transit'], ['SND', 'in_transit'], ['RCPOPS', 'accepted'],
    ]);
    const [summary, events] = replies('pickup');
    const later = (codes: string[]) => ({ ...events, events: [{ date: '07.02.2026', activity: codes.map((code, index) =>
      scan(`1${9 - index}:00:00`, code, 'Почтовое отделение Образцово-4')) }, ...(events.events as Day[])] });
    expect(parseKazpost(summary, later(['ISSPAY']), PICKUP)).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: office });
    const moved = parseKazpost(summary, later(['DPAY', 'RDR']), PICKUP);
    expect(moved).toMatchObject({ status: 'delivered', last_status_text: 'Успешно вручено адресату' });
    expect(moved).not.toHaveProperty('pickup_point');
  });

  it('cancels a corrected scan, keeps a scan listed twice once, and keeps a code nothing words for review', async () => {
    const result = await carrier(serve('in-transit')).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Прибыло в центр сортировки',
      last_update_local: '2026-02-08T06:25:00', weight_kg: 2, destination_country: 'KZ' });
    expect(result.events!.map(event => [event.local_time, event.provider_code])).toEqual([
      ['2026-02-08T06:25:00', 'PRC'], ['2026-02-08T06:00:00', 'PRC'], ['2026-02-07T19:00:00', 'SND'], ['2026-02-07T10:00:00', 'RCPOPS'],
    ]);
    const [summary, events] = replies('in-transit');
    const newer = { ...events, events: [{ date: '09.02.2026', activity: [scan('08:00:00', 'SAMPLE_NEW')] }, ...(events.events as Day[])] };
    const unknown = parseKazpost(summary, newer, IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SAMPLE_NEW',
      last_update_local: '2026-02-09T08:00:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-02-09T08:00:00', location: 'Отделение Образцово, Город Образцово, улица Почтовая, дом 4',
      description: 'SAMPLE_NEW', provider_code: 'SAMPLE_NEW' });
    // A correction on one leg cancels that leg's scan; one without a leg cancels the latest on either.
    const legs = parseKazpost(summary, history(IN_TRANSIT, [{ date: '09.02.2026', activity: [
      scan('09:03:00', 'ISSPAY_UNDO_I'), scan('09:02:00', 'ISSPAY_I'), scan('09:01:00', 'STR_UNDO'), scan('09:00:00', 'STR'),
    ] }]), IN_TRANSIT);
    expect(legs).toMatchObject({ summary_only: true, provider_code: 'PRC', last_status_text: 'В пути' });
    const undone = parseKazpost(summary, history(IN_TRANSIT, [{ date: '09.02.2026', activity: [
      scan('09:03:00', 'DPAY_UNDO_O'), scan('09:02:00', 'DPAY_I'), scan('09:01:00', 'STR'),
    ] }]), IN_TRANSIT);
    expect(undone.events!.map(event => event.provider_code)).toEqual(['DPAY_I', 'STR']);
    expect(kazpostUndone('DLV_UNDO')).toEqual(['DLV', 'DLV_I', 'DLV_O']);
    expect(kazpostUndone('RDRSC_UNDO_O')).toEqual(['RDRSC_O']);
    expect(kazpostUndone('DLV')).toBeNull();
  });

  it('answers an item without a scan the page shows with its summary’s status, and one without either as having no history', () => {
    const result = parseKazpost(...replies('summary-only'), SUMMARY_ONLY);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Зарегистрирован', provider_code: 'RCP', last_update: null, expected_delivery: null,
      weight_kg: 0.325, destination_country: 'PL', summary_only: true, events: [] });
    const [summary, events] = replies('summary-only');
    const hidden = history(SUMMARY_ONLY, [{ date: '01.02.2026', activity: [scan('10:00:00', 'TRN'), scan('09:00:00', 'Act_G')] }]);
    expect(parseKazpost({ ...summary, status: 'Выдан', status_code: 'BOXISS', weight: 0, receiver: {} }, hidden, SUMMARY_ONLY))
      .toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Выдан',
        provider_code: 'BOXISS', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    const unworded = parseKazpost({ ...summary, status: '', status_code: 'SAMPLE' }, events, SUMMARY_ONLY);
    expect(unworded).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE', provider_code: 'SAMPLE', summary_only: true });
    expect(unworded).not.toHaveProperty('current_stage');
    expect(() => parseKazpost({ ...summary, status: null, status_code: null }, events, SUMMARY_ONLY))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s notice for this number as a missing item, and any other notice as inconclusive', async () => {
    const notFound = json('not-found');
    expect(() => parseKazpost(notFound, notFound, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(serve('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The notice in the other languages the API writes it in.
    for (const error of [`Бұл ${UNKNOWN} трек нөмірі бойынша ақпарат жоқ. Трек нөмірінің дұрыстығын тексеріңіз.`,
      `There is no information on this tracking number ${UNKNOWN}. Check the correctness of the track number.`]) {
      expect(() => parseKazpost({ ...notFound, error }, notFound, UNKNOWN), error).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    const other = { ...notFound, error: 'Sample service notice' };
    expect(() => parseKazpost(other, other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An item the summary knows and the history does not is no answer either way.
    const [summary] = replies('delivered');
    expect(() => parseKazpost(summary, { ...notFound, trackid: DELIVERED, error: (notFound.error as string).replaceAll(UNKNOWN, DELIVERED) }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A notice for another number is not this number's answer.
    expect(() => parseKazpost(notFound, notFound, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKazpost({ ...notFound, trackid: DELIVERED }, notFound, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a block page as a challenge, even with HTTP 200, and anything else that is not JSON as a changed service', async () => {
    expect(() => kazpostJson(BLOCKED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => kazpostJson(SHELL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(kazpostJson('\uFEFF{"trackid":"ZZ000000014KZ"}')).toEqual({ trackid: DELIVERED });
    const lookup = (body: string, type = 'text/html') => carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, 200, type)))
      .track({ number: DELIVERED });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(SHELL)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds both replies to the whole requested code and rejects a changed reply', () => {
    const [summary, events] = replies('delivered');
    expect(() => parseKazpost(summary, events, 'ZZ000000062KZ')).toThrow(expect.objectContaining({ kind: 'schema', message: 'Kazpost answered for a different item' }));
    expect(() => parseKazpost(summary, { ...events, trackid: 'ZZ000000062KZ' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKazpost({ ...summary, trackid: undefined }, events, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseKazpost({ ...summary, trackid: DELIVERED.toLowerCase() }, events, DELIVERED).events).toHaveLength(8);
    const days = events.events as Day[];
    const withDay = (day: unknown) => ({ ...events, events: [day, ...days.slice(1)] });
    const first = days[0]!;
    const withScan = (change: Json) => withDay({ ...first, activity: [{ ...first.activity[0], ...change }, ...first.activity.slice(1)] });
    for (const changed of [
      [], 'events', { ...events, events: undefined }, { ...events, events: {} }, withDay(null), withDay({ ...first, activity: undefined }),
      withDay({ ...first, date: '2026-02-03' }), withDay({ ...first, date: '30.02.2026' }), withScan({ time: '16:11' }), withScan({ time: '24:00:00' }),
      withScan({ status: 'DPAY_I' }), withScan({ status: [] }), withScan({ status: [7] }), withDay([]),
      history(DELIVERED, [{ date: '03.02.2026', activity: Array.from({ length: 2_001 }, () => scan('10:00:00', 'PRC')) }]),
    ]) {
      expect(() => parseKazpost(summary, changed, DELIVERED), JSON.stringify(changed).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseKazpost(null, events, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015KZ', 'ZZ00000001KZ', 'ZZ000000014KZX', 'Z0000000014KZ', '+77000000000', '87000000000', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKazpostNumber(' zz-000-000-028 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(serve('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-03T16:11:19' });
    await expect(carrier(serve('summary-only')).recognize!(SUMMARY_ONLY)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(serve('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it('tries once more after a failed connection or a gateway timeout, inside the caller’s budget', async () => {
    const delivered = serve('delivered');
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(delivered);
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    for (const status of [502, 504]) {
      const gateway = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Gateway Time-out</body></html>', status, 'text/html'))
        .mockImplementation(delivered);
      await expect(carrier(gateway).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
      expect(gateway).toHaveBeenCalledTimes(4);
    }
    const down = vi.fn<typeof fetch>().mockImplementation(async () => reply('<html><body>Gateway Time-out</body></html>', 504, 'text/html'));
    await expect(carrier(down).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', status: 504 });
    expect(down).toHaveBeenCalledTimes(4);
    const immediate = serve('delivered');
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(4);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    // A failed request does not leave the other one running.
    const hanging = vi.fn<typeof fetch>((input, init) => String(input).endsWith('/events')
      ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      : Promise.resolve(reply(fixture('not-found'), 403)));
    await expect(carrier(hanging).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(1_000_001)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Kazpost to the adapter', async () => {
    const fetcher = serve('delivered');
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'kazpost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'kazpost', source: 'kazpost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(KAZPOST_TRACKING_API))).toBe(true);
  });

  it('is asked about Kazakh S10 codes, which detection leaves with the postal fallback, and reads both page addresses', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('kazpost');
    expect(recognitionAskedCarriers('ZZ000000015KZ')).not.toContain('kazpost');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('kazpost');
    for (const link of [`https://post.kz/services/postal/${DELIVERED}`, `https://www.post.kz/services/postal/${DELIVERED}/`,
      `https://post.kz/mail/search/track/${DELIVERED}/detail`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'kazpost', source: 'link' });
    }
  });
});

describe('Kazpost status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it, and drops the codes the page hides', () => {
    for (const entry of statuses.entries) {
      const wording = 'wording' in entry && entry.wording ? normalizeStatusWording(entry.wording) : 'synthetic wording';
      if ('stage' in entry) {
        expect(kazpostStage(entry.code), entry.code).toBe(entry.stage);
        expect(statusMap.stage(entry.code, wording), entry.code).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'kazpost', providerCode: entry.code, description: wording }), entry.code)
          .toEqual({ kind: 'mapped', stage: entry.stage });
        expect(isHiddenKazpostCode(entry.code), entry.code).toBe(false);
        continue;
      }
      expect(statusMap.stage(entry.code, wording), entry.code).toBeUndefined();
      // A code the page shows without a stage is a gap; one it hides never reaches a result.
      if (kazpostWording(entry.code) !== undefined) {
        expect(statusMapAnswer({ carrier: 'kazpost', providerCode: entry.code, description: wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
      } else {
        expect(isHiddenKazpostCode(entry.code), entry.code).toBe(true);
      }
    }
    // Delivered to the pickup point is not a delivery.
    expect(kazpostStage('Delivered')).toBe('ready_for_pickup');
    for (const code of ['constructor', 'toString', '__proto__', 'dpay', 'SAMPLE']) {
      expect(kazpostStage(code), code).toBeUndefined();
      expect(kazpostWording(code), code).toBeUndefined();
    }
    expect(statusMap.stage(null, 'вручено')).toBeUndefined();
    for (const code of ['Act', 'Act_S', 'New_act_B', 'DLV_UNDO', 'ISSPAY_UNDO_I', 'TRN', 'PRC_I']) expect(isHiddenKazpostCode(code), code).toBe(true);
    for (const code of ['DLV', 'PRC', 'DLV_HAND', 'Registered', 'SAMPLE']) expect(isHiddenKazpostCode(code), code).toBe(false);
  });
});
