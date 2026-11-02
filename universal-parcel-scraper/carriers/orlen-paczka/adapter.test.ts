import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, OrlenPaczkaTracker } from './adapter.js';
import { normalizeOrlenPaczkaNumber, parseOrlenPaczka } from './parser.js';
import { orlenPaczkaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '2109999000003';
const HANDOFF = '2109999000010';
const ENDPOINT = `https://nadaj.orlenpaczka.pl/parcel/api-status?id=${NUMBER}`;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.jsonp`, import.meta.url), 'utf8');
const wrap = (payload: unknown) => `callback(${JSON.stringify(payload)});`;
const envelope = (history: unknown[], extra: Record<string, unknown> = {}) => wrap({ status: 'OK', number: NUMBER, full: true,
  historyHtml: '', history, label: '', return: false, truckNo: NUMBER, returnTruck: 'Brak danych', ...extra });
const scan = (date: string, code: string, label: string) => ({ date, code, label: `${label} `, labelShort: 'Synthetic' });
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/javascript; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ORLEN Paczka parser', () => {
  it('projects the history newest first, on Polish time, with the sorting centres as locations', () => {
    const result = normalizeCarrierResult(parseOrlenPaczka(fixture('delivered'), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Cieszymy się, że Twoja paczka została już odebrana z punktu odbioru',
      last_update: '2026-03-05T14:59:00+01:00', delivered_at: '2026-03-05T14:59:00+01:00' });
    expect(result.history_truncated).toBeUndefined();
    expect(result.events?.map(event => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-05T14:59:00+01:00', '1000', 'delivered', undefined],
      ['2026-03-05T13:37:00+01:00', '690', 'ready_for_pickup', undefined],
      ['2026-03-05T10:18:00+01:00', '680', 'in_transit', undefined],
      ['2026-03-05T08:15:00+01:00', '653', 'in_transit', 'Wzorowo Małe'],
      ['2026-03-04T18:14:00+01:00', '100', 'in_transit', 'Przykładowo'],
      ['2026-03-04T15:05:00+01:00', '240', 'accepted', undefined],
      ['2026-03-03T18:55:00+01:00', '200', 'registered', undefined],
    ]);
    expect(result.events?.[4]).toEqual({ time: '2026-03-04T18:14:00+01:00', description: 'Twoja paczka została przyjęta w sortowni Przykładowo',
      provider_code: '100', location: 'Przykładowo', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('keeps a parcel handed to another country\'s carrier in transit, whatever its code\'s category says', () => {
    const result = normalizeCarrierResult(parseOrlenPaczka(fixture('handoff'), HANDOFF));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-01-16T20:00:00+01:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map(event => [event.provider_code, event.stage, event.location])).toEqual([
      ['690', 'in_transit', undefined], ['300', 'in_transit', undefined], ['100', 'in_transit', undefined],
      ['210', 'accepted', undefined], ['200', 'registered', undefined],
    ]);
    const collected = parseOrlenPaczka(envelope([scan('16-01-2026, 20:00', '690', 'Paczka przekazana do przewoźnika w innym kraju. Dalszą drogę możesz śledzić w aplikacji Vinted'),
      scan('02-02-2026, 20:30', '1000', 'Odebrana przez Klienta')]), NUMBER);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-02-02T20:30:00+01:00' });
    expect(parseOrlenPaczka(envelope([scan('16-01-2026, 20:00', '690', 'Paczka w innym kraju')]), NUMBER))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseOrlenPaczka(envelope([scan('16-01-2026, 20:00', '690', 'Twoja paczka czeka na odbiór w punkcie')]), NUMBER))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('keeps an unknown code visible without a stage, and a newest unknown scan leaves the status unknown', () => {
    const result = parseOrlenPaczka(envelope([scan('03-03-2026, 18:55', '200', 'Twoja paczka jest w trakcie przygotowania przez nadawcę'),
      scan('04-03-2026, 09:00', '777', 'Synthetic unfamiliar wording')]), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic unfamiliar wording' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]).toEqual({ time: '2026-03-04T09:00:00+01:00', description: 'Synthetic unfamiliar wording', provider_code: '777' });
  });

  it('leaves a wall clock the Polish zone repeats or skips without an offset', () => {
    const result = parseOrlenPaczka(envelope([scan('29-03-2026, 02:30', '200', 'Twoja paczka jest w trakcie przygotowania przez nadawcę'),
      scan('25-10-2026, 02:30', '240', 'Twoja paczka została odebrana przez kuriera i ruszyła w drogę'),
      scan('26-10-2026, 09:00', '100', 'Twoja paczka została przyjęta w sortowni Przykładowo')]), NUMBER);
    expect(result.events?.map(event => [event.time, event.local_time, event.provider_time_text])).toEqual([
      ['2026-10-26T09:00:00+01:00', undefined, undefined],
      [undefined, '2026-10-25T02:30:00', undefined],
      [undefined, undefined, '29-03-2026, 02:30'],
    ]);
    const local = parseOrlenPaczka(envelope([scan('25-10-2026, 02:30', '240', 'Twoja paczka została odebrana przez kuriera i ruszyła w drogę')]), NUMBER);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-10-25T02:30:00' });
  });

  it('marks a history the tracker does not give in full', () => {
    const result = parseOrlenPaczka(envelope([scan('03-03-2026, 18:55', '200', 'Twoja paczka jest w trakcie przygotowania przez nadawcę')], { full: false }), NUMBER);
    expect(result.history_truncated).toBe(true);
  });

  it('reads the explicit no-data answers as not found, bound to the requested number', () => {
    expect(() => parseOrlenPaczka(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A number starting 3 is answered with an OK status and the same placeholder.
    const three = '3000000000000';
    expect(() => parseOrlenPaczka(wrap({ status: 'OK', number: three, full: true, historyHtml: '', history: [], label: '',
      return: false, truckNo: 'Brak danych', returnTruck: 'Brak danych' }), three)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOrlenPaczka(fixture('not-found'), HANDOFF)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps withheld, inconclusive, foreign and malformed replies apart from a missing parcel', () => {
    expect(() => parseOrlenPaczka('callback({"err":1004});', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'tracking_withheld' }));
    expect(() => parseOrlenPaczka('callback({"err":1001});', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOrlenPaczka(envelope([], { status: 'guest', truckNo: 'Brak danych' }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOrlenPaczka('callback({"status":"logged"});', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOrlenPaczka(envelope([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
    expect(() => parseOrlenPaczka(envelope([scan('03-03-2026, 18:55', '200', 'Synthetic')], { truckNo: HANDOFF }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOrlenPaczka(envelope([{ date: '03-03-2026, 18:55', label: 'Synthetic' }]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOrlenPaczka(envelope([{ date: '03-03-2026, 18:55', code: { nested: true }, label: 'Synthetic' }]), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOrlenPaczka('callback({"status":', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOrlenPaczka('<html><body>Maintenance</body></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOrlenPaczka('<html><title>403 Access Forbidden</title><h1>Przepraszamy, nie możesz kontynuować</h1></html>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('takes the tracker\'s parcel numbers and rejects sending codes and a failed check digit', () => {
    expect(normalizeOrlenPaczkaNumber(' 210 9999 0000 03 ')).toBe(NUMBER);
    expect(normalizeOrlenPaczkaNumber('3000000000000')).toBe('3000000000000');
    for (const number of ['2109999000004', '1234567', '1234567890', '210999900000', '4109999000003']) {
      expect(() => normalizeOrlenPaczkaNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('maps every recorded code and wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      expect(orlenPaczkaStage(entry.code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'orlen-paczka', providerCode: entry.code, description: entry.wording }))
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'orlen-paczka', providerCode: '690', description: 'Twoja paczka czeka na odbiór w punkcie Przykładowo' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'orlen-paczka', description: 'Odebrana przez Klienta' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'orlen-paczka', providerCode: '777', description: 'Odebrana przez Klienta' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString']) expect(orlenPaczkaStage(code, 'Synthetic')).toBeUndefined();
  });
});

describe('ORLEN Paczka HTTP adapter', () => {
  it('uses one anonymous GET through the supplied transport and records it once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OrlenPaczkaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ENDPOINT);
    expect(init).toMatchObject({ headers: { Accept: '*/*', 'User-Agent': 'SyntheticHost/1.0' }, signal: expect.any(AbortSignal) });
    expect(init?.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'orlen-paczka', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('is suggested and asked first among the carriers sharing the number shape when its check digit passes', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['orlen-paczka'] });
    expect(detectCarrierMatch(NUMBER).candidates?.[0]).toBe('orlen-paczka');
    for (const countryHint of [undefined, 'PL', 'FR']) expect(recognitionAskedCarriers(NUMBER, { countryHint })[0]).toBe('orlen-paczka');
    expect(detectCarrierMatch('2109999000004').candidates ?? []).not.toContain('orlen-paczka');
  });

  it('recognizes dated history and explicit absence, and leaves a withheld number inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'))).mockResolvedValueOnce(reply('callback({"err":1004});'));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T13:59:00.000Z' });
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('2109999000004')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('Unavailable', status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('rejects invalid inputs and pre-aborted lookups without sending requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '1234567' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).track({ number: '2109999000004' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging HTTP read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
