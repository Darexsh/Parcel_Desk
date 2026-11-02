import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DragonStarCurierTracker, dragonStarCurierTrackingUrl } from './adapter.js';
import { dragonStarCurierText, normalizeDragonStarCurierNumber, parseDragonStarCurier } from './parser.js';
import { dragonStarCurierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic DSC AWB numbers.
const DELIVERED = '00000001';
const TRANSIT = '00000002';
const RETURNED = '00000003';
const UNKNOWN = '00000009';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (result: ReturnType<typeof parseDragonStarCurier>) => result.events!.map((event) =>
  [event.local_time, event.provider_code ?? null, event.location ?? null, event.description, event.stage ?? null]);
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const NOTICE = /Codul AWB introdus este invalid\.<br \/>\s*Te rugăm să încerci din nou\./;

describe('Dragon Star Curier HTTP adapter', () => {
  it('asks the tracker\'s page for the whole AWB number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DragonStarCurierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://dragonstarcurier.ro/tracking-awb?awb=${TRANSIT}`);
    expect(dragonStarCurierTrackingUrl(TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dragon-star-curier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a returned parcel by the phase its Status box starts with', () => {
    const result = parseDragonStarCurier(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Returnat - EIA - Exceptie in Asteptare', last_update: null, last_update_local: '2026-03-12T10:41:00',
      expected_delivery: null });
    expect(summary(result)).toEqual([
      ['2026-03-12T10:41:00', 'EIA', 'CLUJ-NAPOCA', 'Exceptie in Asteptare', 'exception'],
      ['2026-03-12T05:58:00', null, 'CLUJ-NAPOCA', 'Intrare Centru', 'in_transit'],
      ['2026-03-11T19:02:00', null, 'IASI', 'Iesire Centru', 'in_transit'],
      ['2026-03-04T23:15:00', null, 'IASI', 'Intrare Centru', 'in_transit'],
      ['2026-03-04T18:30:00', null, 'CLUJ-NAPOCA', 'Iesire Centru', 'in_transit'],
      ['2026-03-04T13:07:00', 'PRL', 'CLUJ-NAPOCA', 'Preluata', 'accepted'],
    ]);
    // Scan clocks name no zone and stay local.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a parcel between hubs, once per scan', () => {
    const result = parseDragonStarCurier(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'În tranzit - Intrare Centru', last_update_local: '2026-05-21T04:12:00' });
    expect(summary(result)).toEqual([
      ['2026-05-21T04:12:00', null, 'TIMISOARA', 'Intrare Centru', 'in_transit'],
      ['2026-05-20T20:45:00', null, 'CONSTANTA', 'Iesire Centru', 'in_transit'],
      ['2026-05-20T15:33:00', 'PRL', 'CONSTANTA', 'Preluata', 'accepted'],
    ]);
  });

  it('reads a delivery without who signed for it or their phone number', () => {
    const result = parseDragonStarCurier(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Livrată - Livrat',
      last_update_local: '2026-09-08T14:26:00' });
    expect(summary(result)[0]).toEqual(['2026-09-08T14:26:00', null, 'BRASOV', 'Livrat', 'delivered']);
    expect(summary(result)[1]).toEqual(['2026-09-08T08:03:00', null, 'BRASOV', 'În livrare', 'out_for_delivery']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|0700|semnat/i);
  });

  it('keeps a scan\'s wording without a receiver clause or a phone number', () => {
    expect(dragonStarCurierText('Livrat, semnat: SAMPLE NAME')).toBe('Livrat');
    expect(dragonStarCurierText('Livrat - semnătură SAMPLE NAME')).toBe('Livrat');
    expect(dragonStarCurierText('Livrat - primit de SAMPLE NAME')).toBe('Livrat');
    expect(dragonStarCurierText('Livrat - predat lui SAMPLE NAME')).toBe('Livrat');
    expect(dragonStarCurierText('Destinatar contactat la +40 700 000 000')).toBe('Destinatar contactat la');
    // A parcel received from its sender is not a receiver.
    expect(dragonStarCurierText('Colet primit de la expeditor')).toBe('Colet primit de la expeditor');
    expect(dragonStarCurierText('Intrare  Centru ')).toBe('Intrare Centru');
  });

  it('stages by the newest staged scan when the phase is not one the map holds', () => {
    const body = page('in-transit').replace('În tranzit - Intrare Centru', 'Synthetic phase - Intrare Centru');
    expect(parseDragonStarCurier(body, TRANSIT)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Synthetic phase - Intrare Centru' });
    const silent = body.replace('>Intrare Centru</h5>', '>Synthetic note</h5>');
    const result = parseDragonStarCurier(silent, TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit' });
    expect(result.events![0]).toMatchObject({ description: 'Synthetic note' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker\'s notice for an unknown number as not found, and its error notice as inconclusive', () => {
    expect(() => parseDragonStarCurier(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notice = (text: string) => page('not-found').replace(NOTICE, text);
    expect(() => parseDragonStarCurier(notice('A apărut o eroare.<br />\n Te rugăm să încerci mai târziu.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Dragon Star Curier could not complete the lookup' }));
    expect(() => parseDragonStarCurier(notice('Serviciu indisponibil'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Dragon Star Curier answered with another notice' }));
    // The bare page, as without a number, says nothing about the parcel.
    expect(() => parseDragonStarCurier(page('not-found').replace(/<label class="fw-light h4 text-danger">[\s\S]*?<\/label>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the whole number asked', () => {
    expect(() => parseDragonStarCurier(page('in-transit'), '00000004'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Dragon Star Curier answered for another number' }));
    for (const change of [
      (body: string) => body.replace(`Nr. AWB ${TRANSIT}`, 'Nr. AWB 00000004'),
      (body: string) => body.replace(`<div class="h3 fw-bold mb-0">${TRANSIT}</div>`, '<div class="h3 fw-bold mb-0">000000020</div>'),
    ]) {
      expect(() => parseDragonStarCurier(change(page('in-transit')), TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Dragon Star Curier answered for another number' }));
    }
  });

  it('reads a parcel without scans as no history', () => {
    const empty = page('in-transit').replace(/<hr class="my-5 opacity-25" \/>[\s\S]*?(<div class="bg-primary">)/, '</div>\n$1');
    expect(() => parseDragonStarCurier(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const scan = /<h5 class="fw-bold mb-1 text-white">Intrare Centru<\/h5>/;
    for (const change of [
      (body: string) => body.replace(`Nr. AWB ${TRANSIT}`, TRANSIT),
      (body: string) => body.replace('>Număr AWB<', '>Număr<'),
      (body: string) => body.replace('>Status<', '>Stare<'),
      (body: string) => body.replace('În tranzit - Intrare Centru', ' '),
      (body: string) => body.replace('>Număr AWB<', '>Număr AWB</div><div>x</div><div class="text-uppercase">Număr AWB<'),
      (body: string) => body.replace('21.05.2026, 04:12', '2026-05-21 04:12'),
      (body: string) => body.replace('21.05.2026, 04:12', '31.04.2026, 04:12'),
      (body: string) => body.replace('21.05.2026, 04:12', '21.05.2026, 24:00'),
      (body: string) => body.replace(scan, '<h5 class="fw-bold mb-1 text-white"> </h5>'),
      (body: string) => body.replace(/<h5[^>]*>[^<]*<\/h5>/g, ''),
      (body: string) => body.replace('ISTORIC LIVRARE</h3>', 'ISTORIC LIVRARE</h3><h3>ISTORIC LIVRARE</h3>'),
      (body: string) => body.replace(scan, (row) => row.repeat(301)),
    ]) {
      expect(() => parseDragonStarCurier(change(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers every number with HTTP 200: a 404 is a moved route and a redirect another page.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://dragonstarcurier.ro/' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Dragon Star Curier</title><body>Acasă</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found notice, and asks nothing for a number DSC does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(page('returned')))
      .mockResolvedValueOnce(html(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(RETURNED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T10:41:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DragonStarCurierTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dragon-star-curier', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers DSC does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000001', '0000000001', 'A0000001', 'ABCDEFGH', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDragonStarCurierNumber(' 0000-0001 ')).toBe(DELIVERED);
    expect(normalizeDragonStarCurierNumber('0000001')).toBe('0000001');
    expect(normalizeDragonStarCurierNumber('000000001')).toBe('000000001');
  });

  it('routes a number filed under Dragon Star Curier, or in a tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === dragonStarCurierTrackingUrl(DELIVERED)
      ? html(page('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dragon-star-curier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dragon-star-curier', source: 'dragon-star-curier', result: { current_stage: 'delivered' } });
    for (const link of [`https://dragonstarcurier.ro/tracking-awb?awb=${DELIVERED}`, `https://www.dragonstarcurier.ro/tracking-awb/?awb=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ carrier: 'dragon-star-curier', confidence: 'high' });
    }
  });
});

describe('Dragon Star Curier numbers', () => {
  it('leaves bare seven- and eight-digit numbers to the other carriers that print them', () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('dragon-star-curier');
    expect(detectCarrierMatch('0000001').candidates ?? []).not.toContain('dragon-star-curier');
  });
});

describe('Dragon Star Curier status vocabulary', () => {
  it('records every code and wording with the stage the map gives it', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(dragonStarCurierStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'dragon-star-curier', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Wording reads alike with or without its diacritics.
    expect(dragonStarCurierStage('', 'În livrare')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(dragonStarCurierStage('', 'In livrare')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    // No wording is recorded with two stages.
    const stages = new Map<string, Set<string>>();
    for (const entry of entries) stages.set(entry.wording.toLowerCase(), (stages.get(entry.wording.toLowerCase()) ?? new Set()).add(entry.stage));
    expect([...stages.values()].every((set) => set.size === 1)).toBe(true);
    expect(statusMapAnswer({ carrier: 'dragon-star-curier', providerCode: 'ZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
