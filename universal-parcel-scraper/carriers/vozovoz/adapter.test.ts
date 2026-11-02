import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VOZOVOZ_API, VozovozTracker } from './adapter.js';
import { normalizeVozovozNumber, parseVozovoz } from './parser.js';
import { statusMap, vozovozStage, type VozovozFlags } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '000000001';
const IN_TRANSIT = '000000002';
const UNKNOWN = '000000008';

type Row = Record<string, unknown>;
type Reply = Row & { status: Row; dates: Row };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (body: unknown, init?: ResponseInit) => vi.fn<typeof fetch>(async () => reply(body, init));
const IDLE: VozovozFlags = { isTaken: false, hasArrived: false, isGiven: false, isCanceled: false };
// The parties, sums, contacts and the customer's reference of the fixtures.
const PRIVATE = /Синтетическ|synthetic|example\.com|70000000000|1234|987|SYNTHETIC-REF/;

describe('Vozovoz HTTP adapter', () => {
  it('posts the number as the tracker page does, through the supplied transport', async () => {
    const fetcher = answering(fixture('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VozovozTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(VOZOVOZ_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', Origin: 'https://vozovoz.ru', Referer: 'https://vozovoz.ru/',
    } });
    expect(JSON.parse(String(init.body))).toEqual({ orderID: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vozovoz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an issued order as a summary of its dated milestones, on wall clocks, and keeps nothing else', () => {
    const result = parseVozovoz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Груз выдан', last_update: null, last_update_local: '2026-03-05T14:20:33', expected_delivery: null, summary_only: true });
    expect(result.events).toEqual([
      { local_time: '2026-03-05T14:20:33', description: 'Груз выдан', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T10:15:20', description: 'Заказ создан', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The estimate's window is no milestone.
    expect(JSON.stringify(result)).not.toMatch(/2026-03-06/);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('reads an order on its way by its flags, with the estimate the page shows and without its description or reference', () => {
    const result = parseVozovoz(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Синтетический статус', last_update_local: '2026-04-06T09:05:12', expected_delivery: '2026-04-14', summary_only: true });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-04-06T09:05:12', 'Заказ создан', 'registered'],
    ]);
    expect(JSON.stringify(result.events)).not.toMatch(PRIVATE);
    expect(JSON.stringify(result)).not.toMatch(/пояснение|SYNTHETIC-REF|987|500/);
  });

  it('stages an unknown status by the order’s flags, and drops the estimate once the order is finished', () => {
    const flagged = (flags: Partial<VozovozFlags>) => parseVozovoz(changed('in-transit', (body) => { Object.assign(body.status, IDLE, flags); }), IN_TRANSIT);
    expect(flagged({})).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: '2026-04-14' });
    expect(flagged({ isTaken: true, hasArrived: true })).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: '2026-04-14' });
    expect(flagged({ isTaken: true, isCanceled: true })).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null });
    // An issued order without its issue date is the flags alone.
    expect(flagged({ isTaken: true, isGiven: true })).toMatchObject({ status: 'delivered', expected_delivery: null });
    expect(flagged({ isTaken: true, isGiven: true }).events).toHaveLength(1);
  });

  it('words the issue date by the order’s final status: an issue, or a finished group pickup', () => {
    const group = parseVozovoz(changed('delivered', (body) => {
      body.status.message = 'Групповой забор завершен';
      delete body.dates.arrivalTo;
    }), DELIVERED);
    expect(group).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Групповой забор завершен',
      last_update_local: '2026-03-05T14:20:33', expected_delivery: null });
    expect(group.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Групповой забор завершен', 'accepted'], ['Заказ создан', 'registered'],
    ]);
    // Without a status message the issue keeps the tracker's own wording for it.
    const silent = parseVozovoz(changed('delivered', (body) => { delete body.status.message; }), DELIVERED);
    expect(silent).toMatchObject({ current_stage: 'delivered', last_status_text: null });
    expect(silent.events![0]).toMatchObject({ description: 'Груз выдан', stage: 'delivered' });
    // An issue date the flags do not back is not kept.
    const unbacked = parseVozovoz(changed('delivered', (body) => { body.status.isGiven = false; }), DELIVERED);
    expect(unbacked.events!.map((event) => event.description)).toEqual(['Заказ создан']);
    // On one clock, the issue is the newer milestone.
    const same = parseVozovoz(changed('delivered', (body) => { body.dates.given = body.dates.created; }), DELIVERED);
    expect(same.events!.map((event) => event.description)).toEqual(['Груз выдан', 'Заказ создан']);
  });

  it('keeps a day as a day and leaves out a date 1C never set', () => {
    const result = parseVozovoz(changed('delivered', (body) => {
      body.dates.created = '2026-03-02';
      body.dates.given = '0001-01-01T00:00:00';
    }), DELIVERED);
    expect(result.events).toEqual([{ local_time: '2026-03-02', description: 'Заказ создан', stage: 'registered', stage_source: 'carrier_map' }]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-02' });
  });

  it('reads both of the tracker’s answers to an unknown number as not found, and nothing else', () => {
    expect(() => parseVozovoz(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseVozovoz(fixture('check-number'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseVozovoz({ ...fixture('not-found'), dates: {} }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An echo with a status, a date, a flag or a party is an order.
    const order = (change: (body: Reply) => void) => parseVozovoz(changed('not-found', change), UNKNOWN);
    expect(order((body) => { body.status.message = 'Синтетический статус'; })).toMatchObject({ current_stage: 'registered', events: [] });
    expect(order((body) => { body.dates = { created: '2026-01-02T03:04:05' }; }).events).toHaveLength(1);
    expect(order((body) => { body.status.isTaken = true; })).toMatchObject({ current_stage: 'accepted', last_status_text: null });
    expect(() => order((body) => { body.consignee = 'Синтетический Получатель'; })).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => order((body) => { body.status.description = 'Синтетическое пояснение'; })).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Any other error is a changed request, whatever it says.
    for (const body of [
      { error: 'Некорректный номер заказа', raw: { error: true, status: { message: 'Некорректный номер заказа' } } },
      { error: 'Не заполнен обязательный параметр', raw: { error: true, status: { message: 'Не заполнен обязательный параметр' } } },
      { error: 'Проверьте корректность номера заказа.', raw: { error: true, status: { message: 'Проверьте корректность номера заказа.', code: '4031' } } },
      { error: true },
    ]) {
      expect(() => parseVozovoz(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Vozovoz refused the lookup' }));
    }
  });

  it('counts an order only when it is the number asked', () => {
    // The lookup also finds an order by its customer's own reference, and names that order.
    expect(() => parseVozovoz(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vozovoz answered for another order' }));
    expect(() => parseVozovoz(changed('delivered', (body) => { body.number = '000000003'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseVozovoz(changed('not-found', (body) => { body.number = '000000001'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseVozovoz(changed('delivered', (body) => { body.number = ` ${DELIVERED} `; }), DELIVERED).events).toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.number; },
      (body: Reply) => { body.number = 1; },
      (body: Reply) => { delete (body as Row).status; },
      (body: Reply) => { body.status = 'выдан' as never; },
      (body: Reply) => { body.status.message = ['Груз выдан']; },
      (body: Reply) => { body.status.description = 0; },
      (body: Reply) => { body.status.isGiven = 'true'; },
      (body: Reply) => { body.status.isCanceled = 1; },
      (body: Reply) => { body.dates = 'dates' as never; },
      (body: Reply) => { body.dates = ['2026-03-02T10:15:20'] as never; },
      (body: Reply) => { body.dates.created = '02.03.2026'; },
      (body: Reply) => { body.dates.created = '2026-02-30T10:15:20'; },
      (body: Reply) => { body.dates.given = '2026-03-05T24:00:00'; },
      (body: Reply) => { body.dates.given = '2026-03-05T14:20:33+03:00'; },
      (body: Reply) => { body.dates.arrivalFrom = 20260306; },
    ]) {
      expect(() => parseVozovoz(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVozovoz('reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVozovoz(null, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(answering(body, init)).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('check-number.json'))).rejects.toMatchObject({ kind: 'not_found' });
    // A byte-order mark does not change the reply.
    await expect(lookup(`\uFEFF${text('not-found.json')}`)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://vozovoz.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Qrator's check in place of the reply is a challenge, even with HTTP 200.
    await expect(lookup('<html><head><script src="/__qrator/qauth.js"></script></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Maintenance</body></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"number":', {})).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('<html><body>blocked</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('tries once more after a failure to reach Vozovoz, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VozovozTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vozovoz', step: 'retry', outcome: 'ok' }));
  });

  it('sends no reply that came back once more', async () => {
    const fetcher = answering('{"number":', {});
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
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

  it('recognizes a known order and both not-found replies, and asks nothing for a number Vozovoz does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'))).mockResolvedValueOnce(reply(text('check-number.json')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T14:20:33' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('00000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Vozovoz does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000001', '0000000001', '00000000A', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVozovozNumber(' 000-000-001 ')).toBe(DELIVERED);
  });

  it('tracks a number filed under Vozovoz, and claims no bare nine digits', async () => {
    const tracker = createTracker({ fetcher: answering(fixture('delivered')), providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'vozovoz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'vozovoz', source: 'vozovoz', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('vozovoz');
  });
});

describe('Vozovoz status vocabulary', () => {
  it('records every wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      if (entry.stage) expect(vozovozStage(entry.wording, { ...IDLE, isGiven: true }), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'vozovoz', description: 'Груз выдан' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    // A message the map does not know takes its stage from the flags, which the map does not see.
    expect(statusMapAnswer({ carrier: 'vozovoz', description: 'Синтетический статус' })).toEqual({ kind: 'unknown' });
    expect(vozovozStage('Синтетический статус', { ...IDLE, hasArrived: true })).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(vozovozStage('', IDLE)).toEqual({ stage: 'registered', source: 'carrier_map' });
  });
});
