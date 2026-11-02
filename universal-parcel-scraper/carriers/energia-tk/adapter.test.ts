import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ENERGIA_API, EnergiaTracker } from './adapter.js';
import { energiaDocumentNumber, parseEnergia } from './parser.js';
import { energiaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9901-0000001';
const IN_TRANSIT = '9902-0000002';
const UNKNOWN = '9903-0000003';

type Row = Record<string, unknown>;
type Reply = Row & { states: (Row & { stateInfo: Row | null })[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// What the tracker's backend answers for a path it does not serve.
const UNSERVED = { timestamp: '2026-01-01T00:00:00.000+00:00', status: 403, error: 'Forbidden', path: '/api/v4/synthetic' };

describe('TK Energia HTTP adapter', () => {
  it('asks the tracking page’s lookup for the receipt with its dash once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EnergiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch('99010000001', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ENERGIA_API}?documentNumber=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'energia-tk', step: 'direct', outcome: 'ok' }));
  });

  it('dates the handing out as an instant and keeps its warehouse, without who collected it or the issue clock', () => {
    const result = parseEnergia(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Выдана',
      last_update: '2026-03-12T11:20:05Z', expected_delivery: null, delivered_at: '2026-03-12T11:20:05Z',
      pickup_point: 'Образцово Северная\nг. Образцово, ул. Образцовая, 1', weight_kg: 12.5, summary_only: true,
      events: [{ time: '2026-03-12T11:20:05Z', location: 'Образцово Северная', description: 'Выдана',
        point: { latitude: 50.1234, longitude: 40.5678 }, provider_code: '20-0', stage: 'delivered', stage_source: 'carrier_map' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/Образцов Образец|2026-03-12T18|example\.invalid|000-0000|09:00|Примерск|1000/);
  });

  it('lists each group of a split consignment, its route and its arrival window', () => {
    const result = parseEnergia(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'В рейсе: В пути, мест 2, ПРИМЕРНАЯ ⇒ Образцово', last_update: '2026-05-08T08:15:34Z',
      expected_delivery: '2026-05-25', expected_delivery_from: '2026-05-15',
      pickup_point: 'Образцово Северная\nг. Образцово, ул. Образцовая, 1', weight_kg: 31.5, summary_only: true });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.location ?? null])).toEqual([
      ['2026-05-08T08:15:34Z', '2-2', 'В рейсе: В пути, мест 2, ПРИМЕРНАЯ ⇒ Образцово', null],
      ['2026-05-07T12:56:11Z', '1-2', 'На складе: В пути, мест 1', 'МСК Образцовый П'],
    ]);
  });

  it('is as far as its slowest places, and waits at the warehouse that has them ready', () => {
    const ready = (body: Reply) => Object.assign(body.states[0]!, { idSubState: 3, subStateTitle: 'Готов к выдаче' });
    const split = parseEnergia(changed('in-transit', ready), IN_TRANSIT);
    expect(split).toMatchObject({ current_stage: 'in_transit', last_status_text: 'В рейсе: В пути, мест 2, ПРИМЕРНАЯ ⇒ Образцово' });
    expect(split.events!.map((event) => event.stage)).toEqual(['in_transit', 'ready_for_pickup']);
    const waiting = parseEnergia(changed('in-transit', (body) => { ready(body); body.states.pop(); }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'На складе: Готов к выдаче',
      expected_delivery: null, pickup_point: 'МСК Образцовый П\nг. Примерная, Логистическая ул., 7' });
    expect(waiting).not.toHaveProperty('expected_delivery_from');
    // Door delivery has no warehouse to collect from.
    expect(parseEnergia(changed('in-transit', (body) => { body.isDelivery = true; }), IN_TRANSIT)).not.toHaveProperty('pickup_point');
  });

  it('words cargo still with the sender as the tracker does, without a date', () => {
    const result = parseEnergia(changed('in-transit', (body) => {
      body.states = [{ idState: 0, idSubState: 0, subStateTitle: '', movingDate: null, amount: 3, title: '', stateInfo: null }];
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Груз у отправителя', last_update: null,
      expected_delivery: '2026-05-25' });
    expect(result.events).toEqual([{ description: 'Груз у отправителя', provider_code: '0-0', stage: 'registered', stage_source: 'carrier_map' }]);
  });

  it('reads an unknown receipt as not found and a receipt without states as no history', () => {
    expect(() => parseEnergia(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEnergia(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEnergia(changed('delivered', (body) => { body.states = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a reply only when it names the receipt asked', () => {
    expect(() => parseEnergia(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TK Energia answered for another receipt' }));
    // An empty search answers some receipt with an empty number.
    expect(() => parseEnergia(changed('delivered', (body) => { body.docnum = ''; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEnergia(changed('delivered', (body) => { body.docnum = '0000001'; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseEnergia(fixture('delivered'), '99010000001').status).toBe('delivered');
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).docnum; },
      (body: Reply) => { body.docnum = 99010000001; },
      (body: Reply) => { body.states = 'states' as never; },
      (body: Reply) => { body.states = Array.from({ length: 51 }, () => body.states[0]!); },
      (body: Reply) => { body.states[0] = 'state' as never; },
      (body: Reply) => { body.states[0]!.idState = '20'; },
      (body: Reply) => { body.states[0]!.idSubState = -1; },
      (body: Reply) => { body.states[0]!.title = ['Выдана']; },
      (body: Reply) => { Object.assign(body.states[0]!, { idState: 1, title: '' }); },
      (body: Reply) => { body.states[0]!.movingDate = '12.03.2026'; },
      (body: Reply) => { body.states[0]!.movingDate = 1773314405000; },
      (body: Reply) => { body.states[0]!.stateInfo = 'issued' as never; },
      (body: Reply) => { body.states[0]!.stateInfo!.issued = 'issued'; },
    ]) {
      expect(() => parseEnergia(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (body: Reply) => { body.deliveryDateToFormatted = '2026-05-25'; },
      (body: Reply) => { body.deliveryDateFromFormatted = '31.02.2026'; },
      (body: Reply) => { body.warehouseTo = 'warehouse'; },
      (body: Reply) => { body.states[1]!.stateInfo!.trip = 'trip'; },
    ]) {
      expect(() => parseEnergia(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEnergia({ status: 'INTERNAL_SERVER_ERROR', message: 'Synthetic' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEnergia([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown receipt, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://nrg-tk.pro/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(UNSERVED, { status: 403 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>403 Forbidden</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>ТК Энергия</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ status: 'BAD_REQUEST', message: 'Synthetic' }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
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

  it('recognizes a known receipt and the unknown-receipt answer, and asks nothing for a number Energia does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T11:20:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('99-0000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Energia does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000001', '99010-0000001', '9901-000001', 'R9901-0000001', '990000001', '9901-0000-001', 'SAMPLETRACKING', `9901-${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(energiaDocumentNumber(' 9901 0000001 ')).toBe(DELIVERED);
    expect(energiaDocumentNumber('901-0000001')).toBe('901-0000001');
    expect(energiaDocumentNumber('0000001')).toBe('0000001');
    expect(energiaDocumentNumber('9901-0000001r')).toBe('9901-0000001R');
  });

  it('routes a receipt filed under TK Energia to the adapter, with its dash back', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'energia-tk' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'energia-tk', source: 'energia-tk', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${ENERGIA_API}?documentNumber=${DELIVERED}`)).toBe(true);
  });
});

describe('TK Energia numbers', () => {
  it('leaves its receipts unclaimed: other carriers’ eleven-digit numbers share them', () => {
    for (const number of [DELIVERED, '99010000001', '901-0000001', '0000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('energia-tk');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('energia-tk');
    }
  });
});

describe('TK Energia status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      if (entry.unmapped) {
        expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'energia-tk', providerCode: entry.code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'energia-tk', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'energia-tk', providerCode: '9-0', description: 'Синтетика' })).toEqual({ kind: 'unknown' });
    // A state the map does not know takes the tracker's label, else the shared wording rules.
    expect(energiaStage('9-0', 'Готов к выдаче', 'Синтетика: Готов к выдаче')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(energiaStage('9-0', 'Синтетика', 'Синтетика')).toBeNull();
  });
});
