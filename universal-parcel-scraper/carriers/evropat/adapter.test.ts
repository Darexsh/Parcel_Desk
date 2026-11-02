import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EVROPAT_API, EvropatTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeEvropatNumber, parseEvropat } from './parser.js';
import { evropatStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '0000012345';
const IN_TRANSIT = '0000067890';

type Row = Record<string, unknown>;
type Reply = Row & { statuses: Row[] };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const waybill = (name: string) => JSON.parse(fixture(name)) as Reply;
const changed = (name: string, change: (reply: Reply) => void): Reply => {
  const reply = waybill(name);
  change(reply);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
const NOT_FOUND = fixture('not-found');

describe('Evropat HTTP adapter', () => {
  it('posts the whole waybill to the tracking page’s lookup once, anonymously, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EvropatTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 00000 67890 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(EVROPAT_API);
    expect(String(url)).toBe('https://evropat.bg/wp-json/evropat/v1/track');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), body: JSON.stringify({ barcode: IN_TRANSIT }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.keys(init!.headers as Row).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'evropat', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered waybill newest first on Sofia time, with the offices its steps name', () => {
    const result = parseEvropat(waybill('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Разнесена', last_update: '2026-03-03T13:47:21+02:00', delivered_at: '2026-03-03T13:47:21+02:00',
      timezone: 'Europe/Sofia' });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-03-03T13:47:21+02:00', 'Разнесена', null, 'delivered'],
      ['2026-03-03T09:02:33+02:00', 'В куриер за разнос', null, 'out_for_delivery'],
      ['2026-03-03T00:12:09+02:00', 'Разтоварена в офис', 'ДРУГО', 'in_transit'],
      ['2026-03-02T21:30:00+02:00', 'Натоварена от офис', 'ПРИМЕРНО', 'in_transit'],
      ['2026-03-02T18:05:47+02:00', 'Приета в офис', 'ПРИМЕРНО', 'accepted'],
      ['2026-03-02T16:40:11+02:00', 'Приета от куриер', null, 'accepted'],
      // Steps at the same clock keep the order Evropat added them in.
      ['2026-03-02T10:15:03+02:00', 'Разпечатана', null, 'registered'],
      ['2026-03-02T10:15:03+02:00', 'Създадена', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no courier, signatory, note or line', () => {
    const text = JSON.stringify(parseEvropat(waybill('delivered'), DELIVERED));
    for (const kept of ['Иван', 'Петър', 'мария', 'Забележка', 'Синтетична', 'Куриер номер', '1001', '3003', 'НЛ', '2002', '->']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('keeps the wall clock of a step in the hour the clock change repeats, and a state the map does not know without a stage', () => {
    const result = parseEvropat(waybill('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Синтетичен статус',
      last_update: '2026-10-25T08:10:00+02:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toEqual({ time: '2026-10-25T08:10:00+02:00', description: 'Синтетичен статус' });
    expect(result.events![1]).toEqual({ local_time: '2026-10-25T03:30:00', description: 'Разгрупирана',
      location: 'ДРУГО ПРОМИШЛЕНА ЗОНА', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ time: '2026-10-24T21:15:00+03:00', location: 'ПРИМЕРНО' });
  });

  it('counts a waybill only when every step names the number asked', () => {
    expect(() => parseEvropat(changed('delivered', (reply) => { reply.statuses[3]!.barcode = '0000054321'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEvropat(changed('delivered', (reply) => { reply.statuses[0]!.barcode = 12345; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a waybill without steps as no history yet, not as found or missing', async () => {
    await expect(lookup('{"ok":true,"statuses":[]}')).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  });

  it('rejects a changed reply', () => {
    const broken: [string, (reply: Reply) => void][] = [
      ['no clock', (reply) => { delete reply.statuses[0]!.dateAndTime; }],
      ['another clock format', (reply) => { reply.statuses[0]!.dateAndTime = '02.03.2026 10:15'; }],
      ['an impossible day', (reply) => { reply.statuses[0]!.dateAndTime = '2026-02-30 10:15:03'; }],
      ['no state', (reply) => { reply.statuses[0]!.stateName = ' '; }],
      ['a step that is not a record', (reply) => { reply.statuses[0] = 'Създадена' as unknown as Row; }],
      ['ok withheld', (reply) => { delete reply.ok; }],
      ['steps that are not a list', (reply) => { reply.statuses = {} as unknown as Row[]; }],
      ['too many steps', (reply) => { reply.statuses = Array.from({ length: 501 }, () => reply.statuses[0]!); }],
    ];
    for (const [label, change] of broken) {
      expect(() => parseEvropat(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the lookup’s own 404 as not found, and keeps a refusal, a bot check and a broken reply apart', async () => {
    await expect(lookup(NOT_FOUND, { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('{"ok":false,"message":"Въведете валиден номер на товарителница."}', { status: 400 }))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    // A 404 of another shape is a moved or broken service.
    await expect(lookup('{"code":"rest_no_route","message":"No route was found matching the URL and request method."}', { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('{"ok":false,"message":"Синтетична грешка."}', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>403 Forbidden</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The lookup's refusal with HTTP 200 is not the waybill.
    for (const body of ['', '<html><title>Проследяване</title></html>', '{}', 'null', NOT_FOUND]) {
      await expect(lookup(body), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup('{}', { headers: { 'Content-Length': String(3_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers the tracking page refuses and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', '123456789012345', 'ZZ123456785BG', 'SAMPLE0001', '', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEvropatNumber('00000-12345')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('ends with the caller’s reason, without a retry, when the caller cancels', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('caller cancelled')) }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = createTracker({ fetcher, providers: [], env: {} })
      .track({ number: IN_TRANSIT, carrier: 'evropat' }, { signal: controller.signal, budgetMs: 2000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a waybill filed under Evropat to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url) === EVROPAT_API ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'evropat' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'evropat', source: 'evropat', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === EVROPAT_API)).toBe(true);
  });
});

describe('Evropat numbers', () => {
  it('accepts every public waybill, which no rule claims, and reads the tracking page links', () => {
    const own = numbers.records.filter((record) => record.context.assessment === 'confirmed');
    expect(own.length).toBeGreaterThan(0);
    for (const record of own) {
      expect(normalizeEvropatNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('evropat');
      expect(recognitionCandidates(record.number).map(({ carrier }) => carrier), record.number).not.toContain('evropat');
    }
    expect(parseTrackingInput(`https://evropat.bg/track/?barcode=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'evropat' });
    expect(parseTrackingInput(`https://evropat.bg/track/?track=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'evropat' });
  });
});

describe('Evropat status vocabulary', () => {
  it('records every state the map knows with the stage it gives', () => {
    const named = statuses.entries.filter((entry) => entry.confirmedBy === 'live');
    expect(named).toHaveLength(10);
    for (const entry of named) {
      expect(evropatStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'evropat', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'evropat', providerCode: null, description: 'Синтетичен статус' })).toEqual({ kind: 'unknown' });
  });
});
