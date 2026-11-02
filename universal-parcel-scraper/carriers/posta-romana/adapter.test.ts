import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_ROMANA_ENDPOINT, PostaRomanaTracker } from './adapter.js';
import { parsePostaRomana } from './parser.js';
import { postaRomanaScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'ZZ000000014RO';
const EXPORTED = 'ZZ000000028RO';
const RETURNED = 'ZZ000000031RO';
const INBOUND = 'ZZ000000045CN';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
// The lookup labels its JSON as HTML.
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Detail = { data: string; ora: string; detaliu: string; unitatePostala: string; orar?: Record<string, string> };
type Reply = { found: boolean; trimitereSimpla: boolean; 'Numarul trimiterii'?: string; summary: Record<string, string>; details: Detail[] };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};

describe('Poșta Română tracking adapter', () => {
  it('posts the whole item code once through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaRomanaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 ro ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.posta-romana.ro/api/track-trace');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect([...new URLSearchParams(String(init!.body))]).toEqual([['awb', COLLECTED]]);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-romana', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected from a post office newest first, on Bucharest’s clock', () => {
    const result = parsePostaRomana(fixture('collected'), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Predat la destinatar', last_update: '2026-03-06T15:38:00+02:00', delivered_at: '2026-03-06T15:38:00+02:00',
      expected_delivery: null, service_name: 'Colet intern', pickup_point: 'Oficiul Postal Proba 2' });
    expect(result.events!.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-06T15:38:00+02:00', 'Predat la destinatar', undefined, 'delivered'],
      ['2026-03-04T08:26:00+02:00', 'Programat pentru predare incepand cu aceasta data', 'Oficiul Postal Proba 2', 'ready_for_pickup'],
      ['2026-03-04T08:25:00+02:00', 'In prelucrare', 'Oficiul Postal Proba 2', 'in_transit'],
      ['2026-03-03T17:40:00+02:00', 'In transport', 'Exemplu HUB Regional', 'in_transit'],
      ['2026-03-03T16:45:00+02:00', 'In prelucrare', 'Exemplu HUB Regional', 'in_transit'],
      ['2026-03-03T11:23:00+02:00', 'In transport', 'Oficiul Postal Exemplu 1', 'in_transit'],
      ['2026-03-02T15:16:00+02:00', 'Primit de la expeditor', 'Oficiul Postal Exemplu 1', 'accepted'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && !('orar' in event))).toBe(true);
    // Out of order in the reply, newest first in the result.
    const shuffled = edited('collected', payload => { payload.details.reverse(); });
    expect(parsePostaRomana(shuffled, COLLECTED).events!.map(event => event.time)).toEqual(result.events!.map(event => event.time));
  });

  it('reads an item sent abroad up to its dispatch, in summer time, and drops repeated scans', () => {
    const result = parsePostaRomana(fixture('exported'), EXPORTED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Expediat din Romania',
      last_update: '2026-06-05T10:33:00+03:00', service_name: 'Scrisoare recomandata ext' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map(event => [event.time, event.description, event.location])).toEqual([
      ['2026-06-05T10:33:00+03:00', 'Expediat din Romania', 'BSI Bucuresti'],
      ['2026-06-04T16:26:00+03:00', 'In prelucrare', 'BSI Bucuresti'],
      ['2026-06-04T13:47:00+03:00', 'In transport', 'Oficiul Postal Exemplu 3'],
      ['2026-06-03T19:00:00+03:00', 'In prelucrare', 'Oficiul Postal Exemplu 3'],
      ['2026-06-03T15:40:00+03:00', 'Primit de la expeditor', 'Oficiul Postal Exemplu 3'],
    ]);
    // The hour the clocks repeat reads as its first occurrence.
    const repeated = edited('exported', payload => { payload.details.push({ ...payload.details[5]!, data: '25.10.2026', ora: '03:30' }); });
    expect(parsePostaRomana(repeated, EXPORTED).last_update).toBe('2026-10-25T03:30:00+03:00');
  });

  it('reads a return delivered to its sender as returned, without a pickup point', () => {
    const result = parsePostaRomana(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Predat la destinatar' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map(event => [event.time, event.description, event.stage])).toEqual([
      ['2026-03-25T10:02:00+02:00', 'Predat la destinatar', 'returned'],
      ['2026-03-23T09:36:00+02:00', 'Programat pentru predare incepand cu aceasta data', 'ready_for_pickup'],
      ['2026-03-23T09:35:00+02:00', 'In prelucrare', 'in_transit'],
      ['2026-03-21T16:06:00+02:00', 'In transport', 'in_transit'],
      // Taken back at the exchange office: a movement, not a new acceptance.
      ['2026-03-21T01:11:00+02:00', 'Primit de la expeditor', 'in_transit'],
      // Equal clocks keep the reply's order.
      ['2026-03-21T00:18:00+02:00', 'In prelucrare', 'in_transit'],
      ['2026-03-21T00:18:00+02:00', 'Returnat catre expeditor', 'returned'],
      ['2026-03-19T21:26:00+02:00', 'Sosit in Romania', 'in_transit'],
      ['2026-03-02T13:59:00+02:00', 'Expediat din Romania', 'in_transit'],
      ['2026-02-27T19:08:00+02:00', 'In prelucrare', 'in_transit'],
      ['2026-02-27T03:31:00+02:00', 'In transport', 'in_transit'],
      ['2026-02-27T01:25:00+02:00', 'In prelucrare', 'in_transit'],
    ]);
    const travelling = edited('returned', payload => { payload.details.splice(9); });
    expect(parsePostaRomana(travelling, RETURNED)).toMatchObject({ status: 'in_transit', last_status_text: 'In transport' });
  });

  it('reads mail from abroad waiting at a post office and names the office', () => {
    const result = parsePostaRomana(fixture('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Programat pentru predare incepand cu aceasta data', last_update: '2026-06-12T08:32:00+03:00',
      pickup_point: 'Oficiul Postal Exemplu 5' });
    expect(result.service_name).toBeUndefined();
    expect(result.events!.at(-1)).toMatchObject({ description: 'Sosit in Romania', location: 'BSI Bucuresti', stage: 'in_transit' });
    // A parcel brought to the door was not collected from an office.
    const door = edited('collected', payload => {
      payload.details.splice(5, 1, { data: '05.03.2026', ora: '09:10', detaliu: 'In transport', unitatePostala: '- Plecat din Oficiul Postal Proba 2' });
    });
    expect(parsePostaRomana(door, COLLECTED).pickup_point).toBeUndefined();
  });

  it('stages diacritics and new wording through the shared rules, and keeps the rest visible without a stage', () => {
    const accented = edited('exported', payload => { payload.details[5]!.detaliu = 'Expediat din România'; });
    expect(parsePostaRomana(accented, EXPORTED)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    const english = edited('collected', payload => { payload.details[6]!.detaliu = 'Item returned to sender'; });
    expect(parsePostaRomana(english, COLLECTED)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language' });
    const unknown = edited('collected', payload => { payload.details[6]!.detaliu = 'Cantarit la ghiseu'; });
    const result = parsePostaRomana(unknown, COLLECTED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Cantarit la ghiseu' });
    expect(result.current_stage).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-03-06T15:38:00+02:00', description: 'Cantarit la ghiseu' });
  });

  it('binds the reply to the whole requested code and rejects malformed histories', () => {
    expect(() => parsePostaRomana(fixture('collected'), 'ZZ000000045RO')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, { found: 'yes' }, { captcha: false },
      edited('collected', reply => { delete reply['Numarul trimiterii']; }),
      edited('collected', reply => { reply['Numarul trimiterii'] = `${COLLECTED} ${EXPORTED}`; }),
      edited('collected', reply => { (reply as { details: unknown }).details = {}; }),
      edited('collected', reply => { reply.details[2]!.ora = '25:75'; }),
      edited('collected', reply => { reply.details[2]!.ora = '1645'; }),
      edited('collected', reply => { reply.details[2]!.data = '2026-03-03'; }),
      edited('collected', reply => { reply.details[2]!.detaliu = ' '; }),
      edited('collected', reply => { (reply.details as unknown[])[2] = 'scan'; })]) {
      expect(() => parsePostaRomana(payload, COLLECTED), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads an unknown code as missing, and unregistered mail or an empty history as inconclusive', () => {
    expect(() => parsePostaRomana(fixture('not-found'), COLLECTED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePostaRomana(fixture('unregistered'), COLLECTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostaRomana(edited('collected', reply => { reply.details = []; }), COLLECTED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes S10 codes with a valid check digit and two letters with eleven digits, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015RO', 'ZZ00000001RO', 'ZZ0000000001', '1234567890123', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    for (const number of ['RR000000014DE', 'zz00000000001']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect([...new URLSearchParams(String(any.mock.calls[1]![1]!.body))]).toEqual([['awb', 'ZZ00000000001']]);
  });

  it('recognizes a known item and an unknown code from plain HTTP, and leaves unregistered mail open', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('collected'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('unregistered')));
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-06T13:38:00.000Z' });
    await expect(carrier(fetcher).recognize!(EXPORTED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(RETURNED)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: COLLECTED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps browser checks, empty and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [['<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'indeterminate'], ['  ', 'indeterminate'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const bom = vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('collected')}`));
    await expect(carrier(bom).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('collected')));
    await expect(carrier(flaky).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    await expect(carrier(immediate).track({ number: COLLECTED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: COLLECTED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: COLLECTED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under Poșta Română to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('collected')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'posta-romana' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posta-romana', source: 'posta-romana', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === POSTA_ROMANA_ENDPOINT)).toBe(true);
  });

  it('is asked about Romanian S10 codes, which detection leaves with the postal fallback, and keeps its links', () => {
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(COLLECTED)[0]).toBe('posta-romana');
    expect(recognitionAskedCarriers('ZZ000000015RO')).not.toContain('posta-romana');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('posta-romana');
    expect(parseTrackingInput(`https://www.posta-romana.ro/track-trace.html?awb=${COLLECTED}`))
      .toMatchObject({ trackingNumber: COLLECTED, carrier: 'posta-romana', source: 'link' });
  });
});

describe('Poșta Română status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(postaRomanaScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(postaRomanaScanStage('În prelucrare')).toBe('in_transit');
    expect(postaRomanaScanStage('Programat pentru predare începând cu această dată')).toBe('ready_for_pickup');
    for (const wording of ['constructor', 'toString', 'In', 'Predat la destinatar - Oficiul Postal Exemplu 1']) {
      expect(postaRomanaScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'predat la destinatar')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'posta-romana', description: 'Programat pentru predare incepand cu aceasta data' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
