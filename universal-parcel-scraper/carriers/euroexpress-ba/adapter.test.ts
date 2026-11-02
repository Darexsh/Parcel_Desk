import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EUROEXPRESS_API, EuroexpressTracker } from './adapter.js';
import { isEuroexpressMissing, normalizeEuroexpressNumber, parseEuroexpress } from './parser.js';
import { euroexpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// The synthetic code every fixture is for, and the address the lookup redirects it to.
const CODE = '123456780';
const OTHER = '000000000';
const LOOKUP = `${EUROEXPRESS_API}?trackingNumber=${CODE}`;
const ROUTE = `/package-metadata/track?trackingNumber=${CODE}`;

const reply = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const redirect = (location = ROUTE) => new Response(`Temporary Redirect. Redirecting to ${location}`,
  { status: 307, headers: { Location: location } });
/** The tracker's two answers: the redirect, then the reply. */
const answering = (body: unknown, init?: ResponseInit) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url) === LOOKUP ? redirect() : json(body, init)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const changed = (name: string, change: (payload: Record<string, unknown>) => void) => {
  const payload = reply(name);
  change(payload);
  return payload;
};
const summary = (result: ReturnType<typeof parseEuroexpress>) => result.events!.map((event) =>
  [event.time ?? event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('EuroExpress HTTP adapter', () => {
  it('asks the tracking page\'s lookup for the whole code and follows its redirect, through the supplied transport', async () => {
    const fetcher = answering(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EuroexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123 456 780 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([LOOKUP, `https://app-api.euroexpress.ba${ROUTE}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init!.body).toBeUndefined();
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'euroexpress-ba', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment\'s scans as instants, staged by its summary, without the person who took it', () => {
    const result = parseEuroexpress(reply('delivered'), CODE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pošiljka je dostavljena', last_update: '2026-01-13T13:42:51+01:00', expected_delivery: null, weight_kg: 2.5 });
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('provider_code');
    expect(summary(result)).toEqual([
      ['2026-01-13T13:42:51+01:00', 'Pošiljka je dostavljena', 'DC Testgrad', null],
      ['2026-01-13T07:55:10+01:00', 'Pošiljka je zadužena za dostavu', 'DC Testgrad', null],
      ['2026-01-13T05:31:47+01:00', 'Pošiljka je stigla u distributivni centar', 'DC Testgrad', null],
      ['2026-01-12T19:02:16+01:00', 'Pošiljka je otpremljena iz distributivnog centra', 'DC Primjerovo', null],
      ['2026-01-12T08:14:03+01:00', 'Pošiljka je preuzeta od pošiljaoca', 'DC Primjerovo', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    // The person who took the parcel, its contents and its dates of sending and receipt are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC RECEIVER|Synthetic contents|08:14:03\.120|13:42:51\.006|"Testgrad"/);
  });

  it('reads wall clocks without an offset as they are, oldest first turned round, once per scan', () => {
    const result = parseEuroexpress(reply('in-transit'), CODE);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Pošiljka je zadužena za dostavu', last_update: null, last_update_local: '2026-07-07T06:12:00' });
    // A zero weight is no weight.
    expect(result).not.toHaveProperty('weight_kg');
    expect(summary(result)).toEqual([
      ['2026-07-07T06:12:00', 'Pošiljka je zadužena za dostavu', 'DC Testgrad', null],
      ['2026-07-06T18:40:00', 'Pošiljka je otpremljena iz distributivnog centra', 'DC Primjerovo', null],
      ['2026-07-06T10:05:00', 'Pošiljka je preuzeta od pošiljaoca', 'DC Primjerovo', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('reads a shipment kept without its scans as its summary alone', async () => {
    const result = await carrier(answering(reply('summary-only'))).track({ number: CODE });
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DOSTAVLJENA', provider_code: '30', last_update: null, expected_delivery: null, weight_kg: 1,
      summary_only: true, events: [] });
    // A code the map does not know keeps the summary without a stage.
    const unknown = changed('summary-only', (payload) => { payload.status = 7; payload.statusOpis = 'SINTETIČKI STATUS'; });
    expect(parseEuroexpress(unknown, CODE)).toMatchObject({ status: 'unknown', last_status_text: 'SINTETIČKI STATUS', provider_code: '7',
      summary_only: true });
    expect(parseEuroexpress(unknown, CODE)).not.toHaveProperty('current_stage');
    // Without scans or a status, nothing is known about the shipment.
    const empty = changed('summary-only', (payload) => { payload.status = null; payload.statusOpis = ''; });
    expect(() => parseEuroexpress(empty, CODE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker\'s 404 for the code asked as not found, and any other 404 as a moved lookup', async () => {
    await expect(carrier(answering(reply('not-found'), { status: 404 })).track({ number: CODE })).rejects.toMatchObject({ kind: 'not_found' });
    expect(isEuroexpressMissing(reply('not-found'), CODE)).toBe(true);
    // The error must name the whole code asked.
    expect(isEuroexpressMissing(reply('not-found'), OTHER)).toBe(false);
    const elsewhere = changed('not-found', (payload) => { payload.exception = { errorMess: 'Cannot GET /package-metadata/track' }; });
    for (const body of [elsewhere, { statusCode: 404, message: 'Not Found' }, '<html><body>Not found</body></html>']) {
      await expect(carrier(answering(body, { status: 404 })).track({ number: CODE }), JSON.stringify(body)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('binds the reply to the whole code asked', () => {
    expect(() => parseEuroexpress(reply('delivered'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EuroExpress answered for another shipment' }));
    for (const sifra of [null, '', 123456780, ['123456780']]) {
      expect(() => parseEuroexpress(changed('delivered', (payload) => { payload.sifra = sifra; }), CODE), JSON.stringify(sifra))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed reply', () => {
    const scans = (change: (rows: Record<string, unknown>[]) => void) => changed('delivered', (payload) => {
      change(payload.events as Record<string, unknown>[]);
    });
    for (const payload of [
      scans((rows) => { rows[0]!.datum = '13.01.2026 13:42'; }),
      scans((rows) => { rows[0]!.datum = '2026-02-30T13:42:51.006+0100'; }),
      scans((rows) => { rows[0]!.datum = '2026-01-13T24:00:00'; }),
      scans((rows) => { rows[0]!.datum = null; }),
      scans((rows) => { rows[0]!.datum = 1768308171006; }),
      scans((rows) => { rows[0]!.opis = ' '; }),
      scans((rows) => { rows[0]!.opis = 4; }),
      scans((rows) => { rows[0]!.centar = { name: 'DC Testgrad' }; }),
      scans((rows) => { rows[0] = 'Pošiljka je dostavljena' as never; }),
      scans((rows) => { rows.push(...Array.from({ length: 301 }, () => rows[0]!)); }),
      changed('delivered', (payload) => { payload.events = {}; }),
      changed('delivered', (payload) => { payload.status = '30'; }),
      changed('delivered', (payload) => { payload.status = -1; }),
      changed('delivered', (payload) => { payload.statusOpis = 30; }),
      changed('delivered', (payload) => { payload.tezina = { kg: 2 }; }),
      changed('delivered', (payload) => { payload.tezina = 'two'; }),
      [],
      null,
    ]) {
      expect(() => parseEuroexpress(payload, CODE), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A weight written as text is still read.
    expect(parseEuroexpress(changed('delivered', (payload) => { payload.tezina = '0,75'; }), CODE)).toMatchObject({ weight_kg: 0.75 });
  });

  it('keeps a moved lookup, a block page, a rate limit, an outage and a broken reply apart, without keeping error bodies', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(answering(body, init)).track({ number: CODE });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 404 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('', { status: 503 })).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup('', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    // An HTML page in place of the reply is a changed reply.
    await expect(lookup('<!doctype html><html><head><title>Synthetic page</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
    const outage = await lookup({ statusCode: 500, exception: { error: 'SYNTHETIC ERROR BODY' } }, { status: 500 })
      .catch((error: unknown) => error);
    expect(outage).toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(JSON.stringify(outage)).not.toContain('SYNTHETIC ERROR BODY');
    expect(outage).not.toHaveProperty('diagnostics');
  });

  it('follows one redirect to the same lookup on the same host, and no other', async () => {
    const moved = (...locations: string[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const location of locations) fetcher.mockResolvedValueOnce(redirect(location));
      fetcher.mockResolvedValue(json(reply('delivered')));
      return carrier(fetcher).track({ number: CODE });
    };
    await expect(moved(`https://app-api.euroexpress.ba${ROUTE}`)).resolves.toMatchObject({ current_stage: 'delivered' });
    // Without a redirect, the first answer is read.
    await expect(moved()).resolves.toMatchObject({ current_stage: 'delivered' });
    for (const locations of [[`https://example.com${ROUTE}`], [`/package-metadata/track?trackingNumber=${OTHER}`],
      [`${ROUTE}&page=2`], ['/'], [ROUTE, ROUTE]]) {
      await expect(moved(...locations), locations.join(' ')).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302 }))).track({ number: CODE }))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('recognizes a known code and an unknown one, and asks nothing for a code EuroExpress does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(reply('delivered')))
      .mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(reply('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(CODE)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-13T12:42:51.000Z' });
    await expect(carrier(fetcher).recognize!(CODE)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('12345678')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(redirect()).mockResolvedValueOnce(json(reply('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EuroexpressTracker({ fetcher, recorder }).fetch(CODE, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'euroexpress-ba', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: CODE }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects codes EuroExpress does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345678', '1234567890', '12345678A', 'RR123456789BA', '', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: CODE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEuroexpressNumber(' 123-456-780 ')).toBe(CODE);
  });

  it('routes a code filed under EuroExpress, or in a tracker link, to the adapter', async () => {
    const tracker = createTracker({ fetcher: answering(reply('delivered')), providers: [], env: {} });
    await expect(tracker.track({ number: CODE, carrier: 'euroexpress-ba' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'euroexpress-ba', source: 'euroexpress-ba', result: { current_stage: 'delivered' } });
    for (const link of [`https://www.euroexpress.ba/pracenje-posiljke/${CODE}`, `https://euroexpress.ba/pracenje-posiljke/${CODE}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: CODE, carrier: 'euroexpress-ba' });
    }
  });
});

describe('EuroExpress numbers', () => {
  it('leaves its nine digits to the caller and links', () => {
    expect(detectCarrierMatch(CODE).candidates).not.toContain('euroexpress-ba');
  });
});

describe('EuroExpress status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(euroexpressStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'euroexpress-ba', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Scans carry no code; their wording falls to the shared rules, which do not read it.
    expect(statusMapAnswer({ carrier: 'euroexpress-ba', description: 'Pošiljka je dostavljena' })).toEqual({ kind: 'unknown' });
    expect(euroexpressStage(null, 'Pošiljka je dostavljena')).toBeNull();
    expect(euroexpressStage('7', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
  });
});
