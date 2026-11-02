import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JET_LOGISTIC_API, JetLogisticTracker } from './adapter.js';
import { normalizeJetLogisticNumber, parseJetLogistic } from './parser.js';
import { jetLogisticStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '990000000101';
const IN_TRANSIT = '990000000202';
const UNKNOWN = '990000000303';

type Reply = { code: number; success: number; answer: string; pay_info: unknown } & Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const lines = (body: Reply) => body.answer.split('\r');
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jet Logistic HTTP adapter', () => {
  it('posts the cargo ID to the cargo check once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JetLogisticTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9900 0000 0101 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(JET_LOGISTIC_API);
    expect(init).toMatchObject({ method: 'POST', body: `TID=${DELIVERED}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jet-logistic', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the steps as wall clocks with their warehouse town, without the goods, the cost or the payments', () => {
    const result = parseJetLogistic(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Груз выдан',
      last_update: null, last_update_local: '2026-03-14', expected_delivery: null,
      events: [
        { local_time: '2026-03-14', description: 'Груз выдан', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T15:20:48', location: 'Усть-Примерск, Северо-Примерская область', description: 'Доставка груза на склад выдачи',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T04:05:33', location: 'Образцово', description: 'Отправка груза со склада приемки',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T17:42:10', location: 'Образцово', description: 'Доставка груза на склад приемки',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T10:00:00', location: 'Образцово', description: 'Забор груза от грузоотправителя',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/ТОВАРЫ|Оплата|Стоимость|345|КЗТ|2026-03-0[23]/);
  });

  it('reads a cargo on its way, and keeps a payment link out', () => {
    const result = parseJetLogistic(changed('in-transit', (body) => {
      body.pay_info = 'https://pay.example.invalid/synthetic-capability';
      body.pay_data = { TID: IN_TRANSIT, valuta_pl: 'KZT' };
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Отправка груза со склада приемки',
      last_update: null, last_update_local: '2026-05-21T19:47:51', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-05-21T19:47:51', 'Примерск, Примерская область', 'in_transit'],
      ['2026-05-20T11:15:02', 'Примерск, Примерская область', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/example\.invalid|KZT|ЗАПЧАСТИ|4 321/);
  });

  it('keeps a step it does not know by its wording, and leaves out undated lines', () => {
    const result = parseJetLogistic(changed('in-transit', (body) => {
      body.answer = [...lines(body).slice(0, 4), ' Примечание: синтетика',
        'Синтетический этап-Примерск-(Примерская область), дата выполнения : 22.05.2026'].join('\r');
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Синтетический этап',
      last_update_local: '2026-05-22' });
    expect(result.events![0]).toEqual({ local_time: '2026-05-22', location: 'Примерск, Примерская область', description: 'Синтетический этап' });
    expect(JSON.stringify(result)).not.toMatch(/Примечание/);
  });

  it('reads the service’s answer for an unknown cargo as not found only when it names the request asked', () => {
    expect(() => parseJetLogistic(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJetLogistic(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetLogistic(changed('not-found', (body) => { body.answer = 'Введите код груза!'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetLogistic(changed('in-transit', (body) => { body.answer = lines(body).slice(0, 2).join('\r'); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a status only when it names the whole cargo ID asked', () => {
    // The service finds a cargo by its last seven digits, whatever comes before them.
    expect(() => parseJetLogistic(fixture('delivered'), '110000000101'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jet Logistic answered for another cargo' }));
    expect(() => parseJetLogistic(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseJetLogistic(fixture('delivered'), '9900-0000-0101').status).toBe('delivered');
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { body.success = '1' as never; },
      (body: Reply) => { body.answer = ['Груз выдан'] as never; },
      (body: Reply) => { body.answer = lines(body).filter((line) => !line.includes('Код груза')).join('\r'); },
      (body: Reply) => { body.answer = `${body.answer}\r Код груза ${DELIVERED}, вид груза ПРОЧЕЕ`; },
      (body: Reply) => { body.answer = body.answer.replace('12.03.2026', '31.02.2026'); },
      (body: Reply) => { body.answer = body.answer.replace('15:20:48', '25:20:48'); },
      (body: Reply) => { body.answer = body.answer.replace('14 марта', '14 мартобря'); },
      (body: Reply) => { body.answer = body.answer.padEnd(40_000, ' '); },
    ]) {
      expect(() => parseJetLogistic(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseJetLogistic([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown cargo, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://jetlogistic.kz/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>403 Forbidden</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>DDoS-Guard</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Джет Логистик</title></html>')).rejects.toMatchObject({ kind: 'schema' });
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

  it('recognizes a known cargo and the unknown-cargo answer, and asks nothing for a number Jet Logistic does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000303')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Jet Logistic does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000303', '99000000010', '9900000001011', 'JL9900000001', 'SAMPLETRACKING', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJetLogisticNumber('9900-0000-0101')).toBe(DELIVERED);
  });

  it('routes a cargo filed under Jet Logistic to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'jet-logistic' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jet-logistic', source: 'jet-logistic', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === JET_LOGISTIC_API && init?.body === `TID=${DELIVERED}`)).toBe(true);
  });
});

describe('Jet Logistic numbers', () => {
  it('leaves its cargo IDs unclaimed: many carriers’ waybills are twelve digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('jet-logistic');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('jet-logistic');
    }
  });
});

describe('Jet Logistic status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jet-logistic', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(jetLogisticStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'jet-logistic', providerCode: null, description: 'Синтетика' })).toEqual({ kind: 'unknown' });
    expect(jetLogisticStage('Синтетика')).toBeNull();
  });
});
