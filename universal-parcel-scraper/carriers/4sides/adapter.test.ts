import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FOURSIDES_API, FoursidesTracker } from './adapter.js';
import { foursidesWording, normalizeFoursidesNumber, parseFoursides } from './parser.js';
import { foursidesStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'FS123456779RU';
const IN_TRANSIT = 'FE123456789RU';
const UNKNOWN = 'FS000000000RU';

type Row = Record<string, unknown>;
type Reply = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('4Sides HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FoursidesTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' fe 123-456-789 ru ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FOURSIDES_API}?number=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '4sides', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivery and its days without who took the parcel, the contract or the towns of the parties', () => {
    const result = parseFoursides(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Попытка доставки (Доставлено)', last_update: null, last_update_local: '2026-03-05', expected_delivery: null,
      weight_kg: 0.5, destination_country: 'RU' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-05', 'Попытка доставки (Доставлено)', 'delivered', null],
      // The attempt that did not deliver, then the hand-over to the courier, as the reply lists that day.
      ['2026-03-04', 'Попытка доставки (В доставке)', 'failed_attempt', null],
      ['2026-03-04', 'Передано в доставку (В доставке)', 'out_for_delivery', null],
      ['2026-03-04', 'Приём (В СЦ)', 'in_transit', 'Образцово (Образцовая область)'],
      // The repeated departure is kept once.
      ['2026-03-03', 'Отбытие из Москвы (У перевозчика)', 'in_transit', null],
      ['2026-03-02', 'Отправка из СЦ (У перевозчика)', 'in_transit', null],
      ['2026-03-02', 'Сбор (В СЦ)', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Образцов(?!о|ая)|получил|000000|документы|Пробный/);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('summary_only');
  });

  it('stages a parcel on its way by its newest event', () => {
    const result = parseFoursides(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Приём (В СЦ)', last_update_local: '2026-03-14', weight_kg: 2.3, destination_country: 'RU' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Приём (В СЦ)', 'in_transit'],
      ['Отбытие из Москвы (У перевозчика)', 'in_transit'],
      ['Задержка в а/п (У перевозчика)', 'exception'],
      ['Отправка из СЦ (У перевозчика)', 'in_transit'],
      ['Сбор (В СЦ)', 'accepted'],
      ['Накладная создана', 'registered'],
    ]);
    expect(result.events![0]).toMatchObject({ location: 'Примерск (Примерный край)' });
  });

  it('takes the delivery day as the tracker does, unless the parcel went back', () => {
    const late = parseFoursides(changed('in-transit', (body) => { body.deliveredDate = '16-03-2026'; }), IN_TRANSIT);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Приём (В СЦ)', last_update_local: '2026-03-16' });
    const returned = parseFoursides(changed('delivered', (body) => {
      body.events.push({ date: '06-03-2026', status: 'Возврат (В доставке)' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_update_local: '2026-03-06' });
    const summary = parseFoursides(changed('delivered', (body) => { body.events = []; }), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Доставлено',
      last_update_local: '2026-03-05', summary_only: true, events: [] });
  });

  it('reads the destination country the reply names in Russian, and keeps a name it cannot read', () => {
    const country = (name: string) => parseFoursides(changed('in-transit', (body) => { body.receiverCountry = name; }), IN_TRANSIT);
    expect(country('Казахстан')).toMatchObject({ destination_country: 'KZ' });
    expect(country('Беларусь')).toMatchObject({ destination_country: 'BY' });
    expect(country('Germany')).toMatchObject({ destination_country: 'DE' });
    expect(country('Нарния')).toMatchObject({ destination_country_name: 'Нарния' });
    expect(country('')).not.toHaveProperty('destination_country_name');
    expect(parseFoursides(changed('in-transit', (body) => { body.weight = '—'; }), IN_TRANSIT)).not.toHaveProperty('weight_kg');
    expect(parseFoursides(changed('in-transit', (body) => { body.weight = '0'; }), IN_TRANSIT)).not.toHaveProperty('weight_kg');
  });

  it('keeps an event and its state, puts its town in its place and drops who took the parcel', () => {
    expect(foursidesWording('Попытка доставки (Доставлено, получил: Образцов)')).toEqual({ description: 'Попытка доставки (Доставлено)', location: '' });
    expect(foursidesWording('Попытка доставки (Доставлено, получатель: Образцов, Пример Примерович)'))
      .toEqual({ description: 'Попытка доставки (Доставлено)', location: '' });
    expect(foursidesWording('Приём (В СЦ, в городе: Образцово (Образцовая область))'))
      .toEqual({ description: 'Приём (В СЦ)', location: 'Образцово (Образцовая область)' });
    expect(foursidesWording('Прибытие (в городе: Образцово)')).toEqual({ description: 'Прибытие', location: 'Образцово' });
    expect(foursidesWording('Накладная создана')).toEqual({ description: 'Накладная создана', location: '' });
    // A clause the tracker does not label as the state or a town is not kept.
    expect(foursidesWording('Доставлено (Доставлено: Образцов, курьер: Пример)')).toEqual({ description: 'Доставлено', location: '' });
    expect(foursidesWording('Доставлено, получил: Образцов')).toEqual({ description: 'Доставлено', location: '' });
    expect(foursidesWording('Сбор (В СЦ')).toEqual({ description: 'Сбор (В СЦ)', location: '' });
    expect(foursidesWording('  ')).toEqual({ description: '', location: '' });
  });

  it('reads the not-found answer for the number asked, and another number’s answer as inconclusive', () => {
    expect(() => parseFoursides(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFoursides(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: '4Sides answered for another waybill' }));
    expect(() => parseFoursides(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: '4Sides answered for another waybill' }));
    expect(parseFoursides(changed('in-transit', (body) => { body.number = 'fe 123456789 ru'; }), IN_TRANSIT).events).toHaveLength(6);
    expect(() => parseFoursides(changed('delivered', (body) => { body.events = []; body.deliveredDate = ''; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.number; },
      (body: Reply) => { body.number = 13; },
      (body: Reply) => { body.events = 'events' as never; },
      (body: Reply) => { delete (body as Row).events; },
      (body: Reply) => { body.events = Array.from({ length: 201 }, () => body.events[0]!); },
      (body: Reply) => { body.events[0] = 'event' as never; },
      (body: Reply) => { body.events[0]!.date = '2026-03-02'; },
      (body: Reply) => { body.events[0]!.date = '30-02-2026'; },
      (body: Reply) => { delete body.events[0]!.date; },
      (body: Reply) => { body.events[0]!.status = ['Сбор']; },
      (body: Reply) => { body.events[0]!.status = ''; },
      (body: Reply) => { body.deliveredDate = '2026-03-05'; },
      (body: Reply) => { body.weight = 0.5; },
    ]) {
      expect(() => parseFoursides(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFoursides(changed('not-found', (body) => { body.events = [{ date: '02-03-2026', status: 'Сбор' }]; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFoursides([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown waybill, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers an unknown waybill with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://4sides.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: 'Введите номер в формате FS123456789RU или FE123456789RU.' }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>DDoS-Guard</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><div id="captcha-container" class="smart-captcha"></div></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Отслеживание отправления | 4Sides</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number 4Sides does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A day alone dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T00:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('FS12345678RU')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers 4Sides does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['FS12345678RU', 'FS1234567890RU', 'FX123456789RU', 'FS123456789US', 'RS123456789RU', '123456789', `FS${'0'.repeat(70)}RU`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFoursidesNumber(' fs 123.456.779 ru ')).toBe(DELIVERED);
  });

  it('routes a number filed under 4Sides to the adapter, and detection leaves the layout to postal numbers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: '4sides' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: '4sides', source: '4sides', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(FOURSIDES_API))).toBe(true);
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      const match = detectCarrierMatch(number);
      expect(match.carrier, number).not.toBe('4sides');
      expect(match.candidates as readonly string[], number).not.toContain('4sides');
    }
  });
});

describe('4Sides status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(foursidesStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: '4sides', description: 'Попытка доставки (Доставлено)' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: '4sides', description: 'Попытка доставки (В доставке)' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: '4sides', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An event the map does not know takes its state's stage, else the shared wording rules.
    expect(foursidesStage('Перемещение (У перевозчика)')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(foursidesStage('Приём (в СЦ)')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(foursidesStage('Synthetic note')).toBeNull();
  });
});
