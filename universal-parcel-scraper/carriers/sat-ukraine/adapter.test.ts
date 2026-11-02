import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAT_API, SatTracker, satLookupUrl } from './adapter.js';
import { normalizeSatNumber, parseSat, SAT_CREATED } from './parser.js';
import { satStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000101';
const IN_TRANSIT = '000000202';
const UNKNOWN = '000000000';

type Row = Record<string, unknown>;
type Waybill = Row & { states: Row[]; currentStatusDetailed: Row };
type Reply = Row & { data: Waybill[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (waybill: Waybill, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The interstitial Cloudflare puts in place of a protected reply.
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('SAT HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill once, without a key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SatTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 202 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SAT_API}?language=uk&app=website&number=${IN_TRANSIT}`);
    expect(satLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toContain('apikey');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sat-ukraine', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, by day, with the branch the cargo was collected from', () => {
    const result = parseSat(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вантаж видано отримувачу', last_update: null, last_update_local: '2026-03-09', expected_delivery: null,
      pickup_point: 'Пробне\nвул. Пробна, 2 (вхід з двору)' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-09', 'ВыданПолучателю', 'delivered', 'Пробне'],
      ['2026-03-05', 'ПоступилНаСкладВыдачи', 'ready_for_pickup', 'Пробне'],
      ['2026-03-05', 'ВыехалСКонечногоТерминала', 'in_transit', 'Тестоград'],
      // The repeated terminal state is kept once.
      ['2026-03-03', 'ПрибылНаКонечныйТерминал', 'in_transit', 'Тестоград'],
      ['2026-03-03', 'ВПути', 'in_transit', 'Зразкове'],
      // States of one day keep the reply's order.
      ['2026-03-02', 'Принят', 'accepted', 'Зразкове'],
      ['2026-03-02', 'ДобавленВВедомостьПередачи', 'registered', 'Зразкове'],
    ]);
    // A state at a branch carries the branch's coordinates; the others have none.
    expect(result.events![0]).toMatchObject({ description: 'Вантаж видано отримувачу', point: { latitude: 49.3333, longitude: 24.4444 } });
    expect(result.events![2]).not.toHaveProperty('point');
    expect(result.events!.every((event) => !event.time && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(normalizeCarrierResult(result).pickup_point).toBe('Пробне\nвул. Пробна, 2 (вхід з двору)');
  });

  it('reads cargo for the door as out for delivery, with no pickup point', () => {
    const result = parseSat(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Вантаж передано кур\'єру',
      last_update_local: '2026-09-17' });
    expect(result).not.toHaveProperty('pickup_point');
    expect(result.events!.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted']);
    // The courier's delivery has the same wording as an issue at the branch, and no pickup point.
    const door = parseSat(changed('in-transit', (waybill) => {
      const delivery = { ...waybill.states.at(-1)!, date: '18.09.2026', status: 'Вантаж видано отримувачу', town: 'Сусіднє', statusRef: 'ДоставленПолучателю' };
      waybill.states.push(delivery);
      waybill.currentStatusDetailed = { ...delivery };
    }), IN_TRANSIT);
    expect(door).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-09-18' });
    expect(door.events![0]).toMatchObject({ location: 'Сусіднє', provider_code: 'ДоставленПолучателю', stage: 'delivered' });
    expect(door).not.toHaveProperty('pickup_point');
  });

  it('names the branch a parcel waits at, with its town when the branch’s name leaves it out', () => {
    const waiting = parseSat(changed('delivered', (waybill) => {
      waybill.states.pop();
      waybill.currentStatusDetailed = { ...waybill.states.at(-1)!, rsp: 'Точка видачі № 7' };
      waybill.states.at(-1)!.rsp = 'Точка видачі № 7';
    }), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Точка видачі № 7\nвул. Пробна, 2 (вхід з двору)\nПробне' });
  });

  it('reads the progress from the current state, and from the newest staged state without one', () => {
    const delayed = parseSat(changed('in-transit', (waybill) => {
      waybill.currentStatusDetailed = { date: '17.09.2026', status: 'Вантаж затримується в дорозі', town: 'Тестоград', statusRef: 'ЗадерживаетсяВПути' };
    }), IN_TRANSIT);
    expect(delayed).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Вантаж затримується в дорозі' });
    const bare = parseSat(changed('in-transit', (waybill) => { delete (waybill as Row).currentStatusDetailed; }), IN_TRANSIT);
    expect(bare).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Вантаж передано кур\'єру', last_update_local: '2026-09-17' });
    // A state without wording keeps its code as its description.
    const silent = parseSat(changed('in-transit', (waybill) => { waybill.states[1]!.status = null; }), IN_TRANSIT);
    expect(silent.events!.at(-2)).toMatchObject({ description: 'ВПути', stage: 'in_transit' });
  });

  it('reads a current state without states as a summary', () => {
    const summary = parseSat(changed('in-transit', (waybill) => { waybill.states = []; }), IN_TRANSIT);
    expect(summary).toMatchObject({ current_stage: 'out_for_delivery', summary_only: true, events: [], provider_code: 'ПереданКурьеру',
      last_update_local: '2026-09-17' });
  });

  it('reads an empty answer as a waybill whose cargo has not reached a branch, as the page does', () => {
    expect(parseSat({ success: 'true', data: [] }, DELIVERED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: SAT_CREATED, last_update: null, expected_delivery: null, summary_only: true, events: [] });
  });

  it('reads an unknown or written-off waybill as not found and another error as inconclusive', () => {
    expect(() => parseSat(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSat({ success: false, error: { code: 'PD2', text: 'Not found' } }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSat(changed('delivered', (waybill) => { waybill.currentStatusDetailed.statusRef = 'Списан'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'not_found', message: 'SAT reports the waybill as written off' }));
    for (const error of [{ code: 'PD9', text: 'Помилка' }, null, 'Помилка']) {
      expect(() => parseSat({ success: 'false', error }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseSat(changed('delivered', (waybill) => { waybill.states = []; delete (waybill as Row).currentStatusDetailed; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a waybill only when it names the number asked', () => {
    expect(() => parseSat(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SAT answered for another waybill' }));
    const two = changed('in-transit', (_waybill, body) => { body.data.unshift(fixture('delivered').data[0]!); });
    expect(parseSat(two, IN_TRANSIT)).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_waybill: Waybill, body: Reply) => { delete (body as Row).success; },
      (_waybill: Waybill, body: Reply) => { body.data = 'waybill' as never; },
      (_waybill: Waybill, body: Reply) => { body.data = ['waybill'] as never; },
      (waybill: Waybill) => { waybill.number = 202; },
      (waybill: Waybill) => { waybill.states = 'states' as never; },
      (waybill: Waybill) => { waybill.states = Array.from({ length: 301 }, () => waybill.states[0]!); },
      (waybill: Waybill) => { waybill.states[0] = 'state' as never; },
      (waybill: Waybill) => { waybill.states[0]!.date = '2026-09-14'; },
      (waybill: Waybill) => { waybill.states[0]!.date = '31.09.2026'; },
      (waybill: Waybill) => { waybill.states[0]!.status = ['Прийнято']; },
      (waybill: Waybill) => { waybill.states[0]!.status = ''; delete waybill.states[0]!.statusRef; },
      (waybill: Waybill) => { waybill.currentStatusDetailed = 'current' as never; },
      (waybill: Waybill) => { waybill.currentStatusDetailed.date = '17/09/2026'; },
    ]) {
      expect(() => parseSat(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSat('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown waybill, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The API answers an unknown waybill with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>404 - File or directory not found.</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.sat.ua/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Microsoft Internet Information Services 8</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more when the request fails to reach the API, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number SAT does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply({ success: 'true', data: [] }));
    // A day alone dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-09T00:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A waybill without cargo at a branch is no evidence of a shipment.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: false });
    await expect(carrier(fetcher).recognize!('00000010')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers SAT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000010', '0000001010', 'SAT000101', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSatNumber('000 000-101')).toBe(DELIVERED);
  });

  it('routes a waybill filed under SAT to the adapter, and leaves a bare nine digits unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'sat-ukraine' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'sat-ukraine', source: 'sat-ukraine', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SAT_API))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('sat-ukraine');
  });
});

describe('SAT status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the one it leaves out', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      const wording = entry.wording ?? entry.code;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'sat-ukraine', providerCode: entry.code, description: wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(satStage(entry.code, wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'sat-ukraine', providerCode: entry.code, description: wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('stages an unknown code by the shared wording rules, which read no Ukrainian, or not at all', () => {
    expect(satStage('Невідомий', 'Delivered')?.stage).toBe('delivered');
    expect(satStage('Невідомий', 'Вантаж видано отримувачу')).toBeNull();
    expect(statusMapAnswer({ carrier: 'sat-ukraine', providerCode: 'Невідомий', description: 'Вантаж видано отримувачу' })).toEqual({ kind: 'unknown' });
  });
});
