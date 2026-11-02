import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KIT_LOOKUP, KIT_PAGE, KitTracker } from './adapter.js';
import { kitCsrf, normalizeKitNumber, parseKit } from './parser.js';
import { kitStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '0000000001';
const IN_TRANSIT = '0000000002';
const UNKNOWN = '0000000009';
const TOKEN = 'A'.repeat(86) + '==';
const COOKIE = `_csrf=${'0'.repeat(64)}%3A2%3A%7Bi%3A0%3Bs%3A5%3A%22_csrf%22%3B%7D`;

type Row = Record<string, unknown>;
type Reply = Row & { status: Row[]; deliveryInfo: Row & { ESubi: Row; EGinf: Row } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const page = (body = text('page.html'), init: ResponseInit = {}, cookies = [`${COOKIE}; path=/; domain=.tk-kit.ru; HttpOnly; SameSite=Lax`]) =>
  new Response(body, { status: 200, ...init, headers: [['Content-Type', 'text/html; charset=UTF-8'],
    ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const notFound = () => reply(text('not-found.json'), { status: 404 });
/** A transport that answers the tracking page and then the lookup with the reply given. */
const site = (lookup: () => Response, tracker: () => Response = () => page()) =>
  vi.fn<typeof fetch>(async (url) => (String(url) === KIT_PAGE ? tracker() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TK KIT HTTP adapter', () => {
  it('opens a session on the tracking page and posts the number with its token, as the page does, through the supplied transport', async () => {
    const fetcher = site(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KitTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [lookupUrl, lookupInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(KIT_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookupUrl).toBe(KIT_LOOKUP);
    expect(lookupInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0',
      Cookie: COOKIE, 'X-CSRF-Token': TOKEN, 'X-Requested-With': 'XMLHttpRequest', Referer: KIT_PAGE,
    } });
    // The form the page's script sends: no captcha answer goes with it.
    expect([...new URLSearchParams(String(lookupInit.body))]).toEqual([
      ['_csrf', TOKEN], ['TrackLoadForm[track_code]', DELIVERED], ['TrackLoadForm[skip_converter]', '0'],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kit-tk', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a consignment collected at the terminal newest first, on wall clocks, with its cities, terminal and weight only', () => {
    const result = parseKit(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Груз выдан', last_update: null, last_update_local: '2026-03-11T14:20:33', expected_delivery: null,
      pickup_point: 'Примерово, ул. Складская, 1', weight_kg: 120.5 });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['2026-03-11T14:20:33', '04', 'delivered', 'Примерово', 'Груз выдан'],
      // Collected at the terminal: the arrival made it ready to collect there.
      ['2026-03-09T07:45:00', '03', 'ready_for_pickup', 'Примерово', 'Груз прибыл на терминал'],
      ['2026-03-04T18:30:05', '02', 'in_transit', 'Образцовск', 'Груз отправлен'],
      ['2026-03-02T11:02:41', '01', 'accepted', 'Образцовск', 'Груз принят на терминале'],
      ['2026-03-02T10:15:20', '00', 'registered', null, 'Новый заказ'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The terminal's phone and hours, the payment, the cargo's volume and pieces, the references and the addresses stay out.
    expect(JSON.stringify(result)).not.toMatch(/0000000000|0000000099|Пн-Пт|0\.500|ОБРПРМ|Синтетическая|Терминал Пример|EStPay|addressId/);
  });

  it('reads a consignment going on to the door as in transit at the terminal, without the estimate or a pickup point', () => {
    const result = parseKit(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Груз прибыл на терминал',
      last_update_local: '2026-04-13T06:55:09', expected_delivery: null, weight_kg: 35.5 });
    expect(result).not.toHaveProperty('pickup_point');
    // The steps come as an object, the estimate (F2) is no step, and a short day is padded.
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null, event.local_time])).toEqual([
      ['03', 'in_transit', 'Тестоград', '2026-04-13T06:55:09'],
      ['02', 'in_transit', 'Образцовск', '2026-04-08T21:10:47'],
      ['01', 'accepted', 'Образцовск', '2026-04-07T12:40:00'],
      ['00', 'registered', null, '2026-04-06T09:05:12'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Получателя|кв\. 7|Опытный|Плановая/);

    // The handover to the driver happens at the terminal; the delivery itself names no place.
    const delivered = parseKit(changed('in-transit', (body) => {
      body.status = [...Object.values(body.status), { date: '14-04-2026', time: '09:00:00', status_code: 'F3', text: 'Груз принят на доставку' },
        { date: '14-04-2026', time: '15:30', status_code: '04', text: 'Груз выдан' }];
    }), IN_TRANSIT);
    expect(delivered).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-04-14T15:30:00' });
    expect(delivered).not.toHaveProperty('pickup_point');
    expect(delivered.events!.slice(0, 3).map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['04', 'delivered', null], ['F3', 'out_for_delivery', 'Тестоград'], ['03', 'in_transit', 'Тестоград'],
    ]);
  });

  it('takes a door or pickup-point route from the delivery type, the six-step route or an ordered delivery alone', () => {
    const atTerminal = (change: (body: Reply) => void) => parseKit(changed('delivered', change), DELIVERED).events![1]!.stage;
    expect(atTerminal(() => {})).toBe('ready_for_pickup');
    expect(atTerminal((body) => { body.deliveryType = 'delivery'; })).toBe('in_transit');
    expect(atTerminal((body) => { body.deliveryType = 'PVZ'; })).toBe('in_transit');
    expect(atTerminal((body) => { body.stepCount = 6; })).toBe('in_transit');
    expect(atTerminal((body) => { body.isDeliveryRequest = true; })).toBe('in_transit');
    expect(parseKit(changed('delivered', (body) => { body.deliveryType = 'PVZ'; }), DELIVERED)).not.toHaveProperty('pickup_point');
  });

  it('reads a cancelled order, steps sharing a clock and steps without the reply’s own wording', () => {
    const cancelled = parseKit(changed('delivered', (body) => {
      body.status = [body.status[0]!, { date: '03-03-2026', time: '09:00:00', status_code: 'ZZ', text: 'Отменен', textMobile: 'Отменен' }];
    }), DELIVERED);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Отменен' });
    expect(cancelled.events![0]).not.toHaveProperty('location');

    const same = parseKit(changed('delivered', (body) => {
      body.status[1]!.date = '02-03-2026';
      body.status[1]!.time = '10:15:20';
      // The page shows its own label; the short one is the last resort.
      body.status[2]!.text = '';
      body.status = [...body.status, { ...body.status[4]! }, { date: '12-03-2026', time: '08:00:00', status_code: 'X9', text: '', textMobile: 'Синтетический шаг' }];
    }), DELIVERED);
    expect(same.events!.map((event) => [event.provider_code, event.description, event.stage ?? null])).toEqual([
      // A code the map does not know keeps no stage of its own.
      ['X9', 'Синтетический шаг', null],
      ['04', 'Груз выдан', 'delivered'],
      ['03', 'Груз прибыл на терминал', 'ready_for_pickup'],
      ['02', 'Груз отправлен', 'in_transit'],
      // On the same clock, the step the reply lists later is the newer one.
      ['01', 'Груз принят на терминале', 'accepted'],
      ['00', 'Новый заказ', 'registered'],
    ]);
    expect(same).toMatchObject({ current_stage: 'delivered', last_status_text: 'Синтетический шаг' });
  });

  it('counts a consignment only when it is the number asked', () => {
    expect(() => parseKit(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TK KIT answered for another consignment' }));
    expect(() => parseKit(changed('delivered', (body) => { body.track_code = '0000000003'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The consignment's own receipt must end in the number too.
    expect(() => parseKit(changed('delivered', (body) => { body.deliveryInfo.ESubi.Xblnr = 'ОБРПРМ0000000003'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page lists several consignments for the visitor to choose from.
    expect(() => parseKit({ multiple: true, cargo_list: [{ code: 'ОБРПРМ0000000001' }, { code: 'ОБРПРМ0000000004' }] }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TK KIT found several consignments for the number' }));
    // The receipt as typed, in lower case, is the same number; a reference of another shape binds nothing.
    expect(parseKit(changed('delivered', (body) => { body.track_code = 'обрпрм0000000001'; }), DELIVERED).events).toHaveLength(5);
    expect(parseKit(changed('delivered', (body) => { body.deliveryInfo.ESubi.Xblnr = 'SYNTHETIC-REF'; }), DELIVERED).events).toHaveLength(5);
    expect(parseKit(changed('delivered', (body) => { delete (body as Row).deliveryInfo; }), DELIVERED)).not.toHaveProperty('weight_kg');
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).track_code; },
      (body: Reply) => { body.track_code = 1; },
      (body: Reply) => { delete (body as Row).status; },
      (body: Reply) => { body.status = 'steps' as never; },
      (body: Reply) => { body.status = Array.from({ length: 101 }, () => body.status[0]!); },
      (body: Reply) => { body.status[0] = 'step' as never; },
      (body: Reply) => { body.status[0]!.status_code = 0; },
      (body: Reply) => { body.status[0]!.status_code = '0 0'; },
      (body: Reply) => { body.status[0]!.date = '2026-03-02'; },
      (body: Reply) => { body.status[0]!.date = '30-02-2026'; },
      (body: Reply) => { body.status[0]!.time = '24:00:00'; },
      (body: Reply) => { delete body.status[0]!.time; },
      (body: Reply) => { body.status[0]!.text = ['Новый заказ']; },
      (body: Reply) => { body.status[0]!.status_code = 'Q1'; body.status[0]!.text = ''; body.status[0]!.textMobile = null; },
      (body: Reply) => { body.cityIn = 'Примерово'; },
      (body: Reply) => { body.deliveryInfo = 'details' as never; },
      (body: Reply) => { body.deliveryInfo.ESubi.Xblnr = { value: 'ОБРПРМ0000000001' }; },
      (body: Reply) => { body.deliveryType = { type: 'delivery' }; },
      (body: Reply) => { body.stepCount = '5'; },
      (body: Reply) => { body.address = ['Примерово'] as never; },
    ]) {
      expect(() => parseKit(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseKit('reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Only estimates, or no steps at all, is no history.
    expect(() => parseKit(changed('delivered', (body) => { body.status = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseKit(changed('in-transit', (body) => { body.status = [Object.values(body.status)[3]!]; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps an unknown number, a moved route, a refused session, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(site(() => reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(site(notFound)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // Any other 404 is a moved route.
    await expect(lookup({ name: 'Not Found', message: 'Страница не найдена.', code: 0, status: 404 }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tk-kit.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Yii's refusal of a token it did not issue, then any other refusal.
    await expect(lookup('Bad Request (#400): Не удалось проверить переданные данные.', { status: 400, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('Bad Request (#400): Неверные параметры.', { status: 400, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { status: 400, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // A captcha page in place of the reply is a challenge, even with HTTP 200; the tracking page is a changed request.
    await expect(lookup('<html><script src="https://smartcaptcha.yandexcloud.net/captcha.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(text('page.html'), { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"track_code":', {})).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it('reads a tracking page without its token or session as changed, and a bot wall in its place as a challenge', async () => {
    const opened = (tracker: () => Response) => carrier(site(() => reply(fixture('delivered')), tracker)).track({ number: DELIVERED });
    await expect(opened(() => page(text('page.html').replace(/<meta name="csrf-token"[^>]*>/, '').replace(/<input type="hidden"[^>]*>/, ''))))
      .rejects.toMatchObject({ kind: 'schema', message: 'TK KIT tracking page carries no lookup token' });
    await expect(opened(() => page(text('page.html'), {}, []))).rejects.toMatchObject({ kind: 'schema', message: 'TK KIT tracking page opened no session' });
    await expect(opened(() => page('<html><head><title>DDoS-Guard</title></head><body>Checking your browser</body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened(() => page('<html><body>Maintenance</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(opened(() => new Response('', { status: 301, headers: { Location: 'https://tk-kit.ru/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(opened(() => new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    // The form's own token stands in for the meta tag.
    expect(kitCsrf(text('page.html').replace(/<meta name="csrf-token"[^>]*>/, ''))).toEqual({ param: '_csrf', token: TOKEN });
    // The page loads a captcha for its feedback form; that is not a check on the lookup.
    await expect(opened(() => page())).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s on the page and the lookup, during retrieval and recognition', async (status, kind) => {
      const blocked = () => new Response('', { status });
      for (const fetcher of [site(() => reply({}), blocked), site(blocked)]) {
        await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
        await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      }
    });

  it('tries once more in a new session after a failure to reach KIT, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KitTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([KIT_PAGE, KIT_LOOKUP, KIT_PAGE, KIT_LOOKUP]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kit-tk', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a known consignment and the not-found reply, and asks nothing for a number KIT does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(notFound());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-11T14:20:33' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers KIT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000001', '00000000001', '000000000A', 'ABCDEF0000000001', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKitNumber(' 000-000-0001 ')).toBe(DELIVERED);
  });

  it('tracks a number filed under KIT, and claims no bare ten digits', async () => {
    const tracker = createTracker({ fetcher: site(() => reply(fixture('delivered'))), providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'kit-tk' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'kit-tk', source: 'kit-tk', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('kit-tk');
  });
});

describe('TK KIT status vocabulary', () => {
  it('records every code and wording with the stage the adapter gives it on a terminal route', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(kitStage(entry.code ?? null, entry.wording, true)?.stage, entry.wording).toBe(entry.stage);
      // The map answers the code, or the wording without one, except the arrival, which needs the route.
      const mapped = statusMap.stage(entry.code ?? null, entry.wording.toLowerCase());
      expect(mapped, entry.wording).toBe(entry.code === '03' || /^прибыл$|прибыл на терминал/i.test(entry.wording) ? undefined : entry.stage);
    }
    expect(kitStage('03', 'Груз прибыл на терминал', false)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(kitStage(null, 'Груз прибыл на терминал', false)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'kit-tk', providerCode: '04', description: 'Груз выдан' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'kit-tk', providerCode: '03', description: 'Груз прибыл на терминал' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'kit-tk', providerCode: 'F2', description: 'Синтетическая оценка' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(kitStage('X9', 'Синтетический шаг', true)).toBeNull();
  });
});
