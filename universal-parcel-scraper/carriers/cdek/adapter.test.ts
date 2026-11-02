import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/userAgent.js';
import { createTracker } from '../../facade/index.js';
import { carrierScan } from '../../providers/shared/scans.js';
import { adapter, CDEK_ENDPOINT, CdekTracker } from './adapter.js';
import { parseCdek } from './parser.js';
import { cdekScan, cdekStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PICKUP = '99000000017';
const COURIER = '99000000025';
const ABSENT = '99999999998';
const ALIAS = 'ZZ900000005US';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (body: string, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  new Response(body, { status, headers });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null,
  userAgent: 'SyntheticHost/1.0' });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Scan = { code: string; name: string; timestamp: string };
type City = { city: { name: string } | null; cityChangelist: Scan[] };
type Milestone = { code: string; name: string; future: boolean; timestamp: string | null; statuses: City[] | null };
type Reply = { type: string; orderNumber: string; data: Record<string, unknown> & { orderNumber: string; trackingDetails: Milestone[] } };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseCdek>) =>
  result.events!.map(event => [event.time, event.provider_code, event.description, event.location, event.stage]);

describe('CDEK tracking adapter', () => {
  it('asks the order page’s tracking service once for the whole number, without a key or cookie, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('pickup')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CdekTracker({ fetcher, recorder }).fetch(' 990-000 000 17 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://my.cdek.ru/api/lkfl/v3/tracing/trackInfoBeta/${PICKUP}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal) });
    const headers = new Headers(init!.headers);
    expect(headers.get('user-agent')).toBe(DEFAULT_USER_AGENT);
    expect(headers.get('accept')).toBe('application/json');
    for (const name of ['cookie', 'authorization', 'content-type']) expect(headers.has(name), name).toBe(false);
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cdek', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // The host's User-Agent replaces the default.
    await carrier(fetcher).track({ number: PICKUP });
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get('user-agent')).toBe('SyntheticHost/1.0');
  });

  it('reads an order collected at a pickup point newest first, on UTC clocks, by city and without people or addresses', () => {
    const result = parseCdek(fixture('pickup'), PICKUP);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручён', last_update: '2026-05-07T15:20:30Z', delivered_at: '2026-05-07T15:20:30Z', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-05-07T15:20:30Z', 'DELIVERED', 'Вручён', undefined, 'delivered'],
      ['2026-05-06T11:22:33.444Z', 'READY_FOR_PICK_UP', 'Поступил. Заберите заказ', 'Образцово', 'ready_for_pickup'],
      ['2026-05-06T08:00:00Z', 'SENT_TO_PICK_UP_POINT', 'Отправлен в пункт выдачи', 'Образцово', 'in_transit'],
      ['2026-05-06T04:05:06.789Z', 'ACCEPTED_AT_SORTING_CENTER', 'Прибыл в сортировочный центр', 'Образцово', 'in_transit'],
      ['2026-05-05T01:02:03.004Z', 'SENT_TO_NEXT_CITY', 'Отправлено в г. Образцово', 'Примерск', 'in_transit'],
      ['2026-05-04T16:45:10Z', 'ACCEPTED_AT_SORTING_CENTER', 'Прибыл в сортировочный центр', 'Примерск', 'in_transit'],
      ['2026-05-04T15:30:00.250Z', 'SENT_TO_SORTING_CENTER', 'Отправлен в сортировочный центр', 'Примерск', 'in_transit'],
      ['2026-05-04T12:00:00.500Z', 'ACCEPTED_FOR_DELIVERY', 'Принят на доставку', 'Примерск', 'accepted'],
      ['2026-05-04T09:10:11.123Z', 'CREATED', 'Создан', undefined, 'registered'],
    ]);
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    for (const [name, number] of [['pickup', PICKUP], ['courier', COURIER]] as const) {
      const serialized = JSON.stringify(parseCdek(fixture(name), number));
      for (const hidden of ['Иван', 'Мария', 'Вымышленн', 'Условн', 'Придуманн', 'Черов', '+7000', '4321', '50.12', 'OBR99', 'Пункт выдачи',
        'Заказ доставлен', '2026-05-09', '2026-05-14', '2026-06-05T11:00', '"2026-06-05"']) {
        expect(serialized, `${name} ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it('leaves out milestones the order has not reached, and reads a courier’s attempts', () => {
    const result = parseCdek(fixture('courier'), COURIER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Выдан курьеру',
      last_update: '2026-06-05T06:10:00.123Z' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result).map(row => [row[1], row[3], row[4]])).toEqual([
      ['PICKED_UP_BY_COURIER', 'Тестоград', 'out_for_delivery'], ['COURIER_DELIVERY_FAILED', 'Тестоград', 'failed_attempt'],
      ['PICKED_UP_BY_COURIER', 'Тестоград', 'out_for_delivery'], ['ACCEPTED_AT_COURIER_POINT', 'Тестоград', 'in_transit'],
      ['SENT_TO_COURIER_POINT', 'Тестоград', 'in_transit'], ['ACCEPTED_AT_SORTING_CENTER', 'Тестоград', 'in_transit'],
      ['SENT_TO_NEXT_CITY', 'Пробное', 'in_transit'], ['ACCEPTED_FOR_DELIVERY', 'Пробное', 'accepted'],
      ['COURIER_DELIVERY_COMPLETED', undefined, 'accepted'], ['COURIER_APPOINTED', undefined, 'registered'], ['CREATED', undefined, 'registered'],
    ]);
    // The milestone a courier's order starts with holds its own scan; it is not repeated.
    expect(result.events!.filter(event => event.provider_code === 'CREATED')).toHaveLength(1);
  });

  it('reads an order that ended without reaching its recipient as an exception', () => {
    const result = parseCdek(edited('pickup', payload => {
      Object.assign(payload.data.trackingDetails.at(-1)!, { code: 'NOT_DELIVERED', name: 'Не вручён' });
    }), PICKUP);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Не вручён' });
    expect(result.delivered_at).toBeUndefined();
    const partly = parseCdek(edited('pickup', payload => { payload.data.trackingDetails.at(-1)!.code = 'PARTIALLY_DELIVERED'; }), PICKUP);
    expect(partly).toMatchObject({ status: 'delivered', delivered_at: '2026-05-07T15:20:30Z' });
  });

  it('orders scans by clock, keeps equal clocks in the reply’s order and drops repeated rows', () => {
    const result = parseCdek(fixture('pickup'), PICKUP);
    const repeated = edited('pickup', payload => {
      const scans = payload.data.trackingDetails[1]!.statuses![1]!.cityChangelist;
      scans.push({ ...scans[0]! });
    });
    expect(parseCdek(repeated, PICKUP).events).toEqual(result.events);
    const tied = edited('pickup', payload => {
      const scans = payload.data.trackingDetails[1]!.statuses![1]!.cityChangelist;
      scans[1]!.timestamp = scans[0]!.timestamp;
    });
    expect(parseCdek(tied, PICKUP).events!.slice(2, 4).map(event => event.provider_code))
      .toEqual(['SENT_TO_PICK_UP_POINT', 'ACCEPTED_AT_SORTING_CENTER']);
    // A milestone without a clock is not an event.
    const unclocked = edited('pickup', payload => { payload.data.trackingDetails.at(-1)!.timestamp = null; });
    expect(parseCdek(unclocked, PICKUP)).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('keeps a code the map does not know visible without a stage', () => {
    const result = parseCdek(edited('pickup', payload => {
      Object.assign(payload.data.trackingDetails.at(-1)!, { code: 'SYNTHETIC_STATE', name: 'Синтетика' });
    }), PICKUP);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Синтетика' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-05-07T15:20:30Z', description: 'Синтетика', provider_code: 'SYNTHETIC_STATE' });
  });

  it('binds the reply to the whole requested number, or names the order a linked number found', () => {
    expect(() => parseCdek(fixture('pickup'), COURIER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const linked = parseCdek(fixture('pickup'), ALIAS);
    expect(linked).toMatchObject({ canonical_tracking_number: PICKUP, current_stage: 'delivered' });
    expect(() => parseCdek(edited('pickup', payload => { payload.orderNumber = COURIER; }), PICKUP))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCdek(edited('pickup', payload => { payload.data.orderNumber = 'ZZ900000005US'; }), ALIAS))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another service's number is shown on that service's tracking.
    expect(() => parseCdek(edited('pickup', payload => { payload.type = 'EXTERNAL'; }), PICKUP))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed histories, and an order without events', () => {
    for (const payload of [null, [], {}, fixture('not-found'), { type: 'CDEK', data: null },
      edited('pickup', reply => { delete (reply.data as Record<string, unknown>).orderNumber; }),
      edited('pickup', reply => { (reply.data as Record<string, unknown>).trackingDetails = {}; }),
      edited('pickup', reply => { reply.data.trackingDetails = Array.from({ length: 51 }, () => reply.data.trackingDetails[0]!); }),
      edited('pickup', reply => { reply.data.trackingDetails[1]!.statuses![0]!.cityChangelist[1]!.timestamp = '2026-05-04T15:30:00'; }),
      edited('pickup', reply => { reply.data.trackingDetails[1]!.statuses![0]!.cityChangelist[1]!.timestamp = '04.05.2026 15:30'; }),
      edited('pickup', reply => { reply.data.trackingDetails[1]!.statuses![0]!.cityChangelist[1]!.code = ''; }),
      edited('pickup', reply => { reply.data.trackingDetails[1]!.statuses![0]!.cityChangelist[1]!.code = 'SENT<b>'; }),
      edited('pickup', reply => { (reply.data.trackingDetails[1]!.statuses![0]! as { cityChangelist: unknown }).cityChangelist = null; }),
      edited('pickup', reply => { (reply.data.trackingDetails as unknown[])[1] = 'milestone'; })]) {
      expect(() => parseCdek(payload, PICKUP), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = edited('pickup', reply => { for (const milestone of reply.data.trackingDetails) milestone.future = true; });
    expect(() => parseCdek(empty, PICKUP)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads only the service’s own notice as a missing order', async () => {
    const absent = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), 404));
    await expect(carrier(absent).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(absent).recognize!(ABSENT)).resolves.toEqual({ known: false });
    for (const body of ['{"message":"Not found","code":"route.missing"}', '<html><body>Not Found</body></html>', '']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 404));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the service’s limits, its bot check and malformed replies apart from missing orders', async () => {
    const servicePipe = '<!DOCTYPE html><html><head></head><script src="https://servicepipe.tech/loaders/0.js"></script>'
      + '<body><div id="id_spinner"><js-challenge-loader></js-challenge-loader></div><div id="id_captcha_frame_div"></div></body></html>';
    for (const [body, status, kind] of [
      ['{"message":"Слишком много запросов","code":"tracing.tracking_limit_exceeded"}', 400, 'rate_limited'],
      ['{"message":"Попробуйте позже","code":"tracing.universal_tracking.try_again_later"}', 422, 'indeterminate'],
      ['{"message":"Слишком короткий номер","code":"tracing.local_validation_5_symbols"}', 422, 'invalid_input'],
      ['{"message":"Too many requests"}', 429, 'rate_limited'], ['<html><body>Too Many Requests</body></html>', 429, 'rate_limited'],
      ['{"message":"Forbidden"}', 403, 'challenge'], ['<html><head><title>403 Forbidden</title></head></html>', 403, 'challenge'],
      [servicePipe, 200, 'challenge'], ['{"message":"Bad request"}', 400, 'transport'],
      ['<html><body>Технические работы</body></html>', 200, 'schema'], ['{"items":[]}', 200, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, { 'Content-Type': 'text/html' }));
      await expect(carrier(fetcher).track({ number: PICKUP }), body).rejects.toMatchObject({ kind });
      // A number the service refuses is not one it knows.
      if (kind === 'invalid_input') await expect(carrier(fetcher).recognize!(PICKUP), body).resolves.toEqual({ known: false });
      else await expect(carrier(fetcher).recognize!(PICKUP), body).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const waited = vi.fn<typeof fetch>().mockResolvedValue(reply('{}', 429, { 'Retry-After': '30' }));
    await expect(carrier(waited).track({ number: PICKUP })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: PICKUP })).rejects.toThrow('unexpectedly large');
  });

  it.each([[401, 'challenge'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"message":"Unauthenticated."}', status));
      await expect(carrier(fetcher).track({ number: PICKUP })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(PICKUP)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('takes 5 to 40 letters and digits, as the app does, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234', 'A'.repeat(41), 'ЗАКАЗ12345', '12345/6789']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const linked = vi.fn<typeof fetch>().mockResolvedValue(reply(text('pickup')));
    await expect(carrier(linked).track({ number: ALIAS.toLowerCase() })).resolves.toMatchObject({ canonical_tracking_number: PICKUP });
    expect(String(linked.mock.calls[0]![0])).toBe(`${CDEK_ENDPOINT}${ALIAS}`);
  });

  it('recognizes a known order and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('pickup'))).mockResolvedValueOnce(reply(text('not-found'), 404));
    await expect(carrier(fetcher).recognize!(PICKUP)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-05-07T15:20:30.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('pickup')));
    await expect(carrier(flaky).track({ number: PICKUP })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('pickup')));
    await expect(carrier(immediate).track({ number: PICKUP }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: PICKUP }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: PICKUP }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an order filed under CDEK to the adapter, and takes the order page’s link', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('pickup')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PICKUP, carrier: 'cdek' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cdek', source: 'cdek', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(CDEK_ENDPOINT))).toBe(true);
    expect(parseTrackingInput(`https://my.cdek.ru/lkfl/order/${PICKUP}`)).toMatchObject({ trackingNumber: PICKUP, carrier: 'cdek', source: 'link' });
  });
});

describe('CDEK status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      if (!entry.code) continue;
      expect(cdekStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, (entry.wording ?? 'synthetic wording').toLowerCase()), entry.code).toBe(entry.stage);
    }
    for (const code of ['constructor', 'toString', 'UNKNOWN']) expect(statusMap.stage(code, 'synthetic wording'), code).toBeUndefined();
    expect(statusMap.stage(null, 'вручён')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cdek', providerCode: 'READY_FOR_PICK_UP', description: 'Поступил. Заберите заказ' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'cdek', providerCode: 'UNKNOWN', description: 'Неизвестно' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
  });

  it('stages the leg labels ParcelsApp relays, which carry no code', () => {
    for (const entry of statuses.entries) {
      if (entry.code) continue;
      expect(cdekScan(entry.wording!), entry.wording).toEqual({ stage: entry.stage, wording: entry.wording });
      expect(carrierScan('cdek', `${entry.wording!.toUpperCase()}.`), entry.wording).toMatchObject({ stage: entry.stage });
      expect(statusMap.stage(null, entry.wording!.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(cdekScan('Вручён')).toBeUndefined();
  });
});
