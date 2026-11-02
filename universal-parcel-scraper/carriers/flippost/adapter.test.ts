import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FLIPPOST_API, FlippostTracker, flippostLookupUrl } from './adapter.js';
import { flippostWaybills } from './number.js';
import { parseFlippost, settleFlippost } from './parser.js';
import { flippostStage, PLANNED_DISPATCH, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NINE = '000000101';
const SEVEN = '0000202';
const EIGHT = '00000303';
// After every day in the fixtures.
const NOW = Date.parse('2026-10-20T12:00:00Z');

type Row = Record<string, unknown>;
type Reply = Row & { data: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A transport answering each dashed waybill with its own reply, and an empty list for any other. */
const answering = (replies: Record<string, () => Response | Promise<Response>>) => vi.fn<typeof fetch>().mockImplementation(async (input) => {
  const waybill = new URL(String(input)).searchParams.get('wbno') ?? '';
  return replies[waybill]?.() ?? reply(fixture('not-found'));
});
const asked = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('wbno'));
// The interstitial Cloudflare puts in place of a protected reply.
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Flip Post waybills', () => {
  it('restores the dashes the API needs, and gives eight digits both of their layouts', () => {
    expect(flippostWaybills(NINE)).toEqual(['00-0000101']);
    expect(flippostWaybills(SEVEN)).toEqual(['000-0202']);
    expect(flippostWaybills(EIGHT)).toEqual(['0000-0303', '00-000-303']);
    expect(flippostWaybills(' 00 0000101 ')).toEqual(['00-0000101']);
    // A number that keeps the dashes of a layout is asked as it is.
    expect(flippostWaybills('00-000-303')).toEqual(['00-000-303']);
    expect(flippostWaybills('0000-0303')).toEqual(['0000-0303']);
    expect(flippostWaybills('000-0202')).toEqual(['000-0202']);
    expect(flippostWaybills('0-0000303')).toEqual(['0000-0303', '00-000-303']);
    for (const number of ['000020', '0000001010', 'FP0000101', '0'.repeat(65), '']) {
      expect(() => flippostWaybills(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Flip Post HTTP adapter', () => {
  it('asks the documented tracking request for the dashed waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FlippostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NINE, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FLIPPOST_API}?dbAct=getTrackInfo&wbno=00-0000101`);
    expect(flippostLookupUrl('00-0000101')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'flippost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with days alone at midnight and without the receiver', () => {
    const result = parseFlippost(fixture('delivered'), NOW);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Доставлено', last_update: null, last_update_local: '2026-03-05T11:12:00', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['2026-03-05T11:12:00', 'Доставлено', 'delivered', null, 'Доставлено'],
      ['2026-03-04T18:05:00', 'Прием возвратов от курьера', 'failed_attempt', null, 'Прием возвратов от курьера'],
      ['2026-03-04T09:41:00', 'Выдано курьеру на доставку', 'out_for_delivery', null, 'Выдано курьеру на доставку'],
      // The town follows "г." without a space, as the tracker writes it.
      ['2026-03-04', 'Прибыло в г.', 'in_transit', 'Тестоград', 'Прибыло в г.Тестоград'],
      // The first row's planned dispatch registers the waybill, at the origin of its leg.
      ['2026-03-03', PLANNED_DISPATCH, 'registered', 'Пробск', 'Планируемая дата отправки Пробск - Тестоград'],
    ]);
    expect(result.events!.every((event) => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Образцова');
  });

  it('reads the manual’s rows, by day, with a later leg’s planned dispatch in transit', () => {
    const result = parseFlippost(fixture('in-transit'), NOW);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Планируемая дата отправки Пробск - Тестоград',
      last_update_local: '2026-09-03' });
    expect(result.events!.map((event) => [event.local_time, event.stage, event.location])).toEqual([
      ['2026-09-03', 'in_transit', 'Пробск'],
      ['2026-09-03', 'in_transit', 'Пробск'],
      // A leg is made at its origin.
      ['2026-09-02', 'in_transit', 'Образцовск'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('В пути Образцовск - Пробск');
  });

  it('leaves a planned dispatch still to come out of the history', () => {
    const later = parseFlippost(changed('in-transit', (rows) => { rows[2]!.atime = '29/10/26 00:00'; }), NOW);
    expect(later).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Прибыло в г.Пробск', last_update_local: '2026-09-03' });
    expect(later.events).toHaveLength(2);
    // A waybill with only a dispatch to come is booked, with no scan yet.
    const booked = parseFlippost(changed('delivered', (rows, body) => {
      body.data = [{ ...rows[0]!, atime: '22/10/26 00:00' }];
    }), NOW);
    expect(booked).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Планируемая дата отправки Пробск - Тестоград', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    // A day that has begun somewhere is not still to come.
    const today = parseFlippost(changed('delivered', (rows, body) => { body.data = [{ ...rows[0]!, atime: '21/10/26 00:00' }]; }), NOW);
    expect(today).toMatchObject({ current_stage: 'registered', last_update_local: '2026-10-21' });
    expect(today.events).toHaveLength(1);
  });

  it('keeps a status it does not know without a stage, and a repeated row once', () => {
    const result = parseFlippost(changed('delivered', (rows) => {
      rows.splice(4, 1, { ...rows[3]! }, { atime: '05/03/26 10:00', astatus: 'Неизвестный статус', aloc: null });
    }), NOW);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Неизвестный статус' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events).toHaveLength(5);
  });

  it('reads an empty list as not found and an unfinished request as inconclusive', () => {
    expect(() => parseFlippost(fixture('not-found'), NOW)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const msg of ['совсем не правильный запрос', 'Неправильный запрос: ', null]) {
      expect(() => parseFlippost({ success: false, msg, data: [] }, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete (body as Row).success; },
      (_rows: Row[], body: Reply) => { body.success = 'true'; },
      (_rows: Row[], body: Reply) => { body.data = {} as never; },
      (_rows: Row[], body: Reply) => { body.data = ['row'] as never; },
      (_rows: Row[], body: Reply) => { body.data = Array.from({ length: 301 }, () => body.data[0]!); },
      (rows: Row[]) => { rows[0]!.atime = '2026-03-03 00:00'; },
      (rows: Row[]) => { rows[0]!.atime = '31/02/26'; },
      (rows: Row[]) => { rows[2]!.atime = '04/03/26 24:10'; },
      (rows: Row[]) => { delete rows[0]!.atime; },
      (rows: Row[]) => { rows[0]!.astatus = ''; },
      (rows: Row[]) => { rows[0]!.astatus = ': Образцова'; },
      (rows: Row[]) => { rows[0]!.astatus = ['В пути']; },
      (rows: Row[]) => { rows[0]!.aloc = { town: 'Пробск' }; },
    ]) {
      expect(() => parseFlippost(changed('delivered', change), NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFlippost('reply', NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('settles an eight-digit number on the one reading Flip Post has rows for', async () => {
    const second = answering({ '00-000-303': () => reply(fixture('delivered')) });
    await expect(carrier(second).track({ number: EIGHT })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(asked(second).sort()).toEqual(['00-000-303', '0000-0303']);
    const first = answering({ '0000-0303': () => reply(fixture('in-transit')) });
    await expect(carrier(first).track({ number: EIGHT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Rows for both readings settle nothing, and rows for neither are not found.
    const both = answering({ '0000-0303': () => reply(fixture('in-transit')), '00-000-303': () => reply(fixture('delivered')) });
    await expect(carrier(both).track({ number: EIGHT })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'several_parcels' });
    await expect(carrier(answering({})).track({ number: EIGHT })).rejects.toMatchObject({ kind: 'not_found' });
    // A number that keeps its dashes is asked in its layout alone.
    const dashed = answering({ '00-000-303': () => reply(fixture('delivered')) });
    await expect(carrier(dashed).track({ number: '00-000-303' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(asked(dashed)).toEqual(['00-000-303']);
    expect(() => settleFlippost([fixture('not-found'), { success: false, msg: '', data: [] }], NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('asks again only the reading that failed to reach Flip Post, and lets any other failure stand', async () => {
    let failed = false;
    const flaky = answering({ '00-000-303': () => {
      if (failed) return reply(fixture('delivered'));
      failed = true;
      throw new TypeError('fetch failed');
    } });
    await expect(carrier(flaky).track({ number: EIGHT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(asked(flaky).sort()).toEqual(['00-000-303', '00-000-303', '0000-0303']);
    const limited = answering({ '0000-0303': () => new Response('', { status: 429 }), '00-000-303': () => reply(fixture('delivered')) });
    await expect(carrier(limited).track({ number: EIGHT })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(limited).toHaveBeenCalledTimes(2);
  });

  it('keeps a moved route, a browser check and a broken reply apart from a missing waybill', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: NINE });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://flippost.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Apache2 Ubuntu Default Page</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NINE })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NINE)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more when the request fails to reach the API, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: NINE }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known waybill and the empty answer, and asks nothing for a number Flip Post does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(NINE)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T11:12:00' });
    await expect(carrier(fetcher).recognize!(SEVEN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000020')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Flip Post does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000020', '0000001010', 'FP0000101', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NINE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a waybill filed under Flip Post to the adapter with its dashes, and leaves bare digits unclaimed', async () => {
    const fetcher = answering({ '00-0000101': () => reply(fixture('delivered')) });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: '00-0000101', carrier: 'flippost' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'flippost', source: 'flippost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === flippostLookupUrl('00-0000101'))).toBe(true);
    for (const number of [NINE, SEVEN, EIGHT]) expect(detectCarrierMatch(number).carrier).not.toBe('flippost');
  });
});

describe('Flip Post status vocabulary', () => {
  it('records every status the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string }[]) {
      // The exception code comes from the waybill exceptions API, which the adapter does not ask.
      if (!entry.code || entry.code === '22') continue;
      const wording = entry.wording!.replace(/: <name>$/, '').toLowerCase();
      if (entry.code === PLANNED_DISPATCH) {
        // Its stage depends on its place in the history.
        expect(statusMap.stage(entry.code, wording)).toBeUndefined();
        continue;
      }
      expect(flippostStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'flippost', providerCode: entry.code, description: entry.wording! }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('gives no stage to a status it does not know', () => {
    expect(flippostStage('Неизвестный статус')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'flippost', providerCode: 'Неизвестный статус', description: 'Неизвестный статус' })).toEqual({ kind: 'unknown' });
  });
});
