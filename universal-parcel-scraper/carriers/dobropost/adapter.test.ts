import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DOBROPOST_API, DOBROPOST_KEY, DobropostTracker } from './adapter.js';
import { dobropostWording, normalizeDobropostNumber, parseDobropost, parseDobropostMissing } from './parser.js';
import { dobropostMappedStage, dobropostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'DBRPST0000000001';
const IN_TRANSIT = 'DBRPST0000000002';
const RUSSIAN_POST = 'DBRPST0000000003';
const UNKNOWN = 'DBRPST0000000000';

type Row = { date: unknown; statusName: unknown; statusRUName: unknown; statusCategoryId: unknown };
type Reply = Record<string, unknown> & { checkpoints: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('DobroPost HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, with the page’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DobropostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dbrpst 0000-0000-02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DOBROPOST_API}?key=${DOBROPOST_KEY}&trackCode=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dobropost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps every scan as an instant at its stated offset, once, newest first, and stages it by its code', () => {
    const result = parseDobropost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручен', last_update: '2026-03-20T15:41:07+03:00', delivered_at: '2026-03-20T15:41:07+03:00',
      expected_delivery: null, destination_country: 'RU' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-20T15:41:07+03:00', 'DELIVERED', 'delivered', 'Образцовск'],
      ['2026-03-19T12:05:33+03:00', 'ACCEPTED_AT_WAREHOUSE_ON_DEMAND', 'ready_for_pickup', 'Образцовск'],
      ['2026-03-19T09:12:48+03:00', 'MET_AT_RECIPIENT_OFFICE', 'in_transit', 'Образцовск'],
      ['2026-03-18T22:30:02+03:00', 'SEND_TO_RECIPIENT_OFFICE', 'in_transit', 'Примерово'],
      // The scan listed twice is kept once.
      ['2026-03-18T21:58:40+03:00', 'PASSED_TO_CARRIER_AT_TRANSIT_OFFICE', 'in_transit', 'Примерово'],
      ['2026-03-18T08:14:19+03:00', 'MET_AT_TRANSIT_OFFICE', 'in_transit', 'Примерово'],
      ['2026-03-17T16:47:55+03:00', 'SEND_TO_TRANSIT_OFFICE', 'in_transit', 'Примерово'],
      ['2026-03-17T16:45:10+03:00', 'PASSED_TO_CARRIER_AT_SENDING_OFFICE', 'in_transit', 'Пробная Слобода'],
      // CDEK's code arrives with a trailing tab.
      ['2026-03-17T11:20:36+03:00', 'READY_TO_SHIP_AT_SENDING_OFFICE', 'in_transit', 'Пробная Слобода'],
      ['2026-03-17T10:58:21+03:00', 'RECEIVED_AT_SHIPMENT_WAREHOUSE', 'in_transit', 'Пробная Слобода'],
      ['2026-03-16T09:44:00+03:00', "LEFT_CUSTOMS_AND_HEADING_TO_LAST_MILE_CARRIER'S_WAREHOUSE", 'in_transit', null],
      ['2026-03-16T08:30:00+03:00', 'READY_FOR_SHIPMENT_FOR_LAST_MILE_DELIVERY', 'in_transit', null],
      ['2026-03-16T02:15:00+03:00', 'RELEASE_OF_GOODS_WITHOUT_PAYMENT_OF_CUSTOMS_DUTIES', 'in_transit', null],
      ['2026-03-14T11:37:12+03:00', 'ARRIVED_AT_CUSTOMS_IN_THE_COUNTRY_OFF_DESTINATION', 'customs', null],
      // Listed before the arrival, but sorted by its clock.
      ['2026-03-13T19:05:00+03:00', 'START_OF_CUSTOMS_CLEARANCE', 'customs', null],
      ['2026-03-12T08:02:44+03:00', 'FLEW_OUT_FROM_CHINA', 'in_transit', null],
      ['2026-03-10T21:16:09+03:00', 'AT_CUSTOMS_IN_CHINA', 'customs', null],
      ['2026-03-09T12:48:31+03:00', 'LEFT_THE_DP_WERHOUSE_IN_CHINA', 'in_transit', null],
      ['2026-03-09T06:11:05+03:00', 'ADDED_TO_THE_REGISTRY', 'accepted', null],
      ['2026-03-07T10:04:52+03:00', 'READY_FOR_SENT', 'accepted', null],
      ['2026-03-07T10:02:13+03:00', 'AWAITING_PAYMENT', 'accepted', null],
      ['2026-03-07T04:39:27+03:00', 'ON_WEIGHING', 'accepted', null],
      ['2026-03-05T18:22:50+03:00', 'ON_ASSEMBLY', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.map((event) => event.description)).toContain('Добавлена в реестр');
    expect(result.events![1]).toMatchObject({ description: 'Принят на склад до востребования' });
  });

  it('reads a parcel at destination customs, on its way to Belarus', () => {
    expect(parseDobropost(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'customs',
      last_status_text: 'Поступила на таможню в стране назначения', last_update: '2026-05-22T13:08:41+03:00', destination_country: 'BY' });
    const result = parseDobropost(fixture('in-transit'), IN_TRANSIT);
    expect(result).not.toHaveProperty('delivered_at');
    // Two export scans a minute apart are two scans.
    expect(result.events!.filter((event) => event.provider_code === 'AT_CUSTOMS_IN_CHINA')).toHaveLength(2);
    const named = parseDobropost(changed('in-transit', (reply) => { reply.recipientCountry = 'Sampleland (Sample Republic)'; }), IN_TRANSIT);
    expect(named).toMatchObject({ destination_country_name: 'Sampleland (Sample Republic)' });
    const none = parseDobropost(changed('in-transit', (reply) => { reply.recipientCountry = null; }), IN_TRANSIT);
    expect(none).not.toHaveProperty('destination_country');
    expect(none).not.toHaveProperty('destination_country_name');
  });

  it('stages Russian Post’s codeless last leg by its operation names', () => {
    const result = parseDobropost(fixture('russian-post'), RUSSIAN_POST);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Вручение',
      delivered_at: '2026-07-14T17:26:03+03:00' });
    expect(result.events!.slice(0, 5).map((event) => [event.description, event.stage, event.provider_code ?? null])).toEqual([
      ['Вручение', 'delivered', null],
      ['Досылка почты', 'in_transit', null],
      ['Возврат', 'returned', null],
      ['Обработка', 'in_transit', null],
      ['Прием', 'in_transit', null],
    ]);
    // An operation the map does not know takes the tracker's category, unless that category mixes stages.
    const unknown = (category: number) => parseDobropost(changed('russian-post', (reply) => {
      Object.assign(reply.checkpoints[0]!, { statusRUName: 'Синтетическая операция', statusCategoryId: category });
    }), RUSSIAN_POST);
    expect(unknown(14)).toMatchObject({ current_stage: 'returned', last_status_text: 'Синтетическая операция' });
    expect(unknown(14).events![0]).toMatchObject({ stage: 'returned', stage_source: 'carrier_map' });
    expect(unknown(11)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Синтетическая операция' });
    expect(unknown(11).events![0]).not.toHaveProperty('stage');
  });

  it('reads a return to China, a refused release and a deleted last-mile order', () => {
    const returned = parseDobropost(changed('in-transit', (reply) => {
      reply.checkpoints.unshift(
        { date: '2026-06-02T10:00:00.000+03:00', statusName: 'RELEASE_OF_GOODS_CUSTOMS_PAYMENTS_PAID', statusRUName: 'Возврат в Китай разрешен', statusCategoryId: 16 },
        { date: '2026-05-25T07:11:00.000+03:00', statusName: 'REFUSAL_TO_RELEASE_GOODS_WITH_INDICATION_OF_THE_CODE_OF_THE_REASON_FOR_REFUSAL',
          statusRUName: 'Отказ в выпуске товаров с указанием кода причины отказа. Товары не для личного пользования (пример).', statusCategoryId: 8 },
      );
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Возврат в Китай разрешен' });
    expect(returned.events![1]).toMatchObject({ stage: 'exception' });
    // The deleted order is listed first whatever its clock, and moves nothing.
    const deleted = parseDobropost(changed('in-transit', (reply) => {
      reply.checkpoints.unshift({ date: '2026-05-23T09:00:00.000+03:00', statusName: 'DELETED_ON_SHIPTOR', statusRUName: 'Удалён на Шипторе', statusCategoryId: 100 });
    }), IN_TRANSIT);
    expect(deleted).toMatchObject({ current_stage: 'customs', last_status_text: 'Удалён на Шипторе' });
    expect(deleted.events![0]).not.toHaveProperty('stage');
  });

  it('keeps the wording as the page shows it, without phone numbers, and the town CDEK names', () => {
    expect(dobropostWording('Вручен (Нижний Образец)', 'DELIVERED')).toEqual({ description: 'Вручен', location: 'Нижний Образец' });
    expect(dobropostWording('Добавлена в реестр № ', 'ADDED_TO_THE_REGISTRY')).toEqual({ description: 'Добавлена в реестр' });
    // Brackets holding a legal reference are not a town.
    expect(dobropostWording('Отказ в выпуске (пп.8 п.1 ст.125)', '')).toEqual({ description: 'Отказ в выпуске (пп.8 п.1 ст.125)' });
    expect(dobropostWording('Позвоните +7 (000) 000-00-00 курьеру', '')).toEqual({ description: 'Позвоните курьеру' });
    expect(dobropostWording('', 'DELIVERED')).toEqual({ description: 'DELIVERED' });
  });

  it('reads the service’s answer for an unknown number as not found, naming the number asked', () => {
    expect(() => parseDobropostMissing(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDobropostMissing({ ...fixture('not-found'), message: `Parcel with trackCode - ${UNKNOWN.toLowerCase()} not found` }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An answer naming another number proves nothing about this one.
    expect(() => parseDobropostMissing(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DobroPost answered for another parcel' }));
    expect(() => parseDobropostMissing({ status: 404, error: 'Not Found', message: 'No message available', path: '/api/tracking/other' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseDobropostMissing(null, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('rejects a changed reply and reads one without scans as no history', () => {
    for (const [index, change] of [
      (reply: Reply) => { delete (reply as Record<string, unknown>).checkpoints; },
      (reply: Reply) => { reply.checkpoints = 'checkpoints' as never; },
      (reply: Reply) => { reply.checkpoints = Array.from({ length: 501 }, () => reply.checkpoints[0]!); },
      (reply: Reply) => { reply.checkpoints[0] = 'scan' as never; },
      (reply: Reply) => { reply.checkpoints[0]!.date = '2026-05-22T13:08:41'; },
      (reply: Reply) => { reply.checkpoints[0]!.date = '22.05.2026 13:08'; },
      (reply: Reply) => { reply.checkpoints[0]!.date = '2026-02-30T13:08:41.000+03:00'; },
      (reply: Reply) => { reply.checkpoints[0]!.date = 1_780_000_000_000; },
      (reply: Reply) => { reply.checkpoints[0]!.statusName = ['DELIVERED']; },
      (reply: Reply) => { reply.checkpoints[0]!.statusRUName = { ru: 'Вручен' }; },
      (reply: Reply) => { reply.checkpoints[0]!.statusName = null; reply.checkpoints[0]!.statusRUName = ' '; },
      (reply: Reply) => { reply.checkpoints[0]!.statusCategoryId = '12'; },
      (reply: Reply) => { reply.checkpoints[0]!.statusCategoryId = 1.5; },
      (reply: Reply) => { reply.recipientCountry = 7; },
    ].entries()) {
      expect(() => parseDobropost(changed('in-transit', change), IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDobropost([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDobropost(changed('in-transit', (reply) => { reply.checkpoints = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps an unknown number, a refused key, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(json(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(json(fixture('key-refused'), { status: 403 }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup(new Response('<html><body>Forbidden</body></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://tracking.dobropost.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(CLOUDFLARE, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CLOUDFLARE, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>DobroPost</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number DobroPost does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('delivered')))
      .mockResolvedValueOnce(json(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-20T12:41:07.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('DBRPST00000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses what DobroPost does not look up as a parcel, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DBRPST000000000', 'DBRPST00000000000', 'DBRPST000000000A', 'SF0000000000000', `DBRPST${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDobropostNumber('dbrpst-0000-0000-01')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under DobroPost, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dobropost' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dobropost', source: 'dobropost', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'dobropost', source: 'dobropost' });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${DOBROPOST_API}?`))).toBe(true);
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'dobropost', confidence: 'high' });
  });
});

describe('DobroPost status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      if (entry.unmapped) {
        expect(dobropostStage(entry.code ?? '', entry.wording, null), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'dobropost', providerCode: code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMapAnswer({ carrier: 'dobropost', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(dobropostStage(entry.code ?? '', entry.wording, null), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads the paid-release code by its wording and leaves unknown codes to the tracker’s category', () => {
    expect(dobropostMappedStage('RELEASE_OF_GOODS_CUSTOMS_PAYMENTS_PAID', 'выпуск товаров с уплатой таможенных платежей')).toBe('in_transit');
    expect(dobropostMappedStage('SYNTHETIC_CODE', 'вручен')).toBeUndefined();
    expect(statusMap.stage(null, 'синтетическая заметка')).toBeUndefined();
    expect(dobropostStage('SYNTHETIC_CODE', 'Синтетическая заметка', 13)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // The categories that mix stages give none.
    for (const category of [7, 9, 11]) expect(dobropostStage('SYNTHETIC_CODE', 'Синтетическая заметка', category)).toBeNull();
    expect(dobropostStage('SYNTHETIC_CODE', 'Синтетическая заметка', null)).toBeNull();
    expect(dobropostStage('', 'Синтетическая заметка', 100)).toBeNull();
  });
});
