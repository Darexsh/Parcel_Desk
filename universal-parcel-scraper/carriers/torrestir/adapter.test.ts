import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TORRESTIR_TRACKER, TorrestirTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeTorrestirNumber, parseTorrestir } from './parser.js';
import { statusMap, torrestirStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'M0010003A00123456781';
const IN_TRANSIT = 'M0010004500234567892';
const UNKNOWN = 'M0010005B00345678903';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
const pageFor = (number: string) => `${TORRESTIR_TRACKER}?id=${number}&lang=pt`;

describe('Torrestir HTTP adapter', () => {
  it('opens the tracker’s Portuguese page for the whole code once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TorrestirTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' m001 0004 5002 3456 7892 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(pageFor(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-PT,pt', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'torrestir', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment newest first as wall clocks, with a failed round and the guia’s day', () => {
    const result = parseTorrestir(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregue', last_update: null, last_update_local: '2026-01-14T11:22:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-01-14T11:22:00', 'Entregue', null, 'delivered'],
      ['2026-01-14T09:10:00', 'Em Distribuiçao', null, 'out_for_delivery'],
      // Brought back to the warehouse from the round, then out again the next day.
      ['2026-01-13T18:05:00', 'Devolvido', 'CIDADE PROVA', 'failed_attempt'],
      ['2026-01-13T09:20:00', 'Em Distribuiçao', null, 'out_for_delivery'],
      ['2026-01-13T05:30:00', 'Na Plataforma de Destino', 'CIDADE PROVA', 'in_transit'],
      ['2026-01-13T02:15:00', 'Em Transito', null, 'in_transit'],
      // Scans of one minute keep the page's order, the later one newer.
      ['2026-01-12T16:40:00', 'Na Plataforma de Origem', 'VILA SINTÉTICA', 'in_transit'],
      ['2026-01-12T16:40:00', 'Recolhido', null, 'accepted'],
      // The guia's creation at midnight exactly is its day.
      ['2026-01-12', 'Guia Criada', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined)).toBe(true);
    // A warehouse keeps the coordinates the page gives it; a leg has none.
    expect(result.events![2]).toMatchObject({ point: { latitude: 38.7777, longitude: -9.3333 } });
    expect(result.events!.filter((event) => event.point)).toHaveLength(3);
  });

  it('reads a shipment out for delivery with its estimate’s day, once per repeated scan', () => {
    const result = parseTorrestir(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Em Distribuiçao',
      last_update_local: '2026-10-27T08:55:00', expected_delivery: '2026-10-27' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null])).toEqual([
      ['2026-10-27T08:55:00', 'Em Distribuiçao', null],
      ['2026-10-26T06:10:00', 'Na Plataforma de Destino', 'VILA PROVA'],
      // The repeated scan is kept once.
      ['2026-10-25T01:30:00', 'Em Transito', null],
      ['2026-10-24T19:45:00', 'Na Plataforma de Origem', 'CENTRO PROVA'],
      // Two days of one date keep the page's order.
      ['2026-10-23', 'Recolhido', null],
      ['2026-10-23', 'Guia Criada', null],
    ]);
  });

  it('keeps the estimate’s day only while it is still to come', () => {
    expect(parseTorrestir(changed('in-transit', '2026-10-27 14:00 / 14:30', '2026-10-26 14:00 / 14:30'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseTorrestir(changed('in-transit', '2026-10-27 14:00 / 14:30', '2026-10-28'), IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-10-28' });
    expect(parseTorrestir(changed('in-transit', '2026-10-27 14:00 / 14:30', '2026-02-30 14:00 / 14:30'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseTorrestir(changed('in-transit', '2026-10-27 14:00 / 14:30', ''), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('keeps no customer, reference, origin, destination or counts', () => {
    const text = JSON.stringify(parseTorrestir(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/EMPRESA|REF-0001|0\.10\.3|12345678|ALDEIA EXEMPLO|ARM\.|Registo|Em Viagem|Destinat/);
  });

  it('keeps a place that is not a warehouse only with its coordinates', () => {
    const page = changed('delivered', 'value="Em Viagem" />\n                                    Em Viagem', 'value="PLATAFORMA SINTÉTICA" />');
    expect(parseTorrestir(page, DELIVERED).events!.at(-2)).not.toHaveProperty('location');
    const placed = changed('delivered', /ARM\. VILA SINT&#201;TICA/g, 'PLATAFORMA SINTÉTICA');
    expect(parseTorrestir(placed, DELIVERED).events!.at(-3)).toMatchObject({ location: 'PLATAFORMA SINTÉTICA', point: { latitude: 41.1111 } });
  });

  it('stages a wording it does not know through the shared rules, or leaves it unstaged', () => {
    const worded = parseTorrestir(changed('in-transit', /Em Distribui&#231;ao/g, 'Entregue ao vizinho'), IN_TRANSIT);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(worded.events![0]).toMatchObject({ stage: 'delivered', stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unstaged = parseTorrestir(changed('in-transit', /Em Distribui&#231;ao/g, 'Nota Sintética'), IN_TRANSIT);
    expect(unstaged).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Nota Sintética', expected_delivery: '2026-10-27' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('reads the empty card as not found and a shipment without scans as no history', () => {
    expect(() => parseTorrestir(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = fixture('delivered').replace(/<tr class="tabela-linhas">[\s\S]*?<\/tr>\s*/g, '');
    expect(() => parseTorrestir(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('binds the page to the whole code: its echo and the guia number the code holds', () => {
    // The page repeats whatever code it is asked, so the echo alone does not bind it.
    expect(() => parseTorrestir(fixture('delivered'), 'M0010003A00123456782')).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Torrestir answered for another shipment' }));
    expect(() => parseTorrestir(changed('delivered', '0.10.3.12345678', '0.10.3.12345679'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Torrestir answered for another shipment' }));
    expect(() => parseTorrestir(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Torrestir's own reference holds the guia number without the code's padding.
    expect(parseTorrestir(changed('delivered', '0.10.3.12345678', '0.10.7.12345678'), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a page with several shipments as inconclusive', () => {
    const page = fixture('delivered');
    const start = page.indexOf('<p class="trackcodet">');
    const card = page.slice(start, page.indexOf('</article>', start) + '</article>'.length);
    const table = page.slice(page.indexOf('<table class="tabela">'), page.indexOf('</table>') + '</table>'.length);
    for (const html of [page.replace(card, `${card}${card}`), page.replace(table, `${table}${table}`)]) {
      expect(() => parseTorrestir(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Torrestir answered for several shipments' }));
    }
  });

  it('rejects a changed page', () => {
    const page = fixture('delivered');
    for (const html of [
      '<html><title>Torrestir - Tracking</title><body>Siga a sua entrega</body></html>',
      changed('delivered', '<table class="tabela">', '<table class="lista">'),
      changed('delivered', 'Nossa Refer&#234;ncia:', 'Referência:'),
      changed('delivered', 'Estimado: ', 'Previsto: '),
      changed('delivered', '0.10.3.12345678', '12345678'),
      changed('delivered', /2026-01-14 11:22/g, '14/01/2026 11:22'),
      changed('delivered', /2026-01-14 11:22/g, '2026-02-30 11:22'),
      changed('delivered', /2026-01-14 11:22/g, '2026-01-14 24:22'),
      changed('delivered', 'value="Entregue"', 'value=" "'),
      changed('delivered', 'name="listaTracking[8].BeginDate"', 'name="listaTracking[8].Begin"'),
      changed('delivered', /listaTracking\[8\]/g, 'listaTracking[9]'),
      page.replace(/listaTracking\[8\]/g, 'listaTracking[200]'),
    ]) {
      expect(() => parseTorrestir(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Scans under the empty card are not the not-found answer.
    const rows = page.slice(page.indexOf('<tr class="tabela-linhas">'), page.indexOf('</table>'));
    expect(() => parseTorrestir(changed('not-found', '</table>', `${rows}</table>`), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown code, a moved route, a bot check, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers a code it does not know itself: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.torrestir.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha" data-sitekey="synthetic"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>Torrestir - Tracking</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that did not reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a page over its size limit', async () => {
    await expect(lookup('x', { headers: { 'Content-Length': String(2_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects what is not a tracking code, guia references included, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['M001000300123456781', 'M00100030A001234567810', 'M0020003A00123456781', 'M0010003AB0123456781',
      '0.10.3.12345678', '010312345678', '12345678', `M001${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTorrestirNumber('m001-0004-5002-3456-7892')).toBe(IN_TRANSIT);
  });

  it('recognizes a shipment the tracker shows and not a code it does not know', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).includes(UNKNOWN) ? 'not-found' : 'delivered')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-14T11:22:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a code filed under Torrestir to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'torrestir' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'torrestir', source: 'torrestir', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pageFor(DELIVERED))).toBe(true);
  });

  it('proposes no hand-off: the page names no other carrier or number', () => {
    expect(deliveryHandoff('torrestir', DELIVERED, parseTorrestir(fixture('delivered'), DELIVERED))).toBeNull();
  });
});

describe('Torrestir numbers', () => {
  it('accepts every public tracking code, which its rule settles without recognition, and reads the tracker link', () => {
    const codes = numbers.records.filter((record) => record.expect.carrier === 'torrestir');
    expect(codes.length).toBeGreaterThan(0);
    for (const record of codes) {
      expect(normalizeTorrestirNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number), record.number).toMatchObject({ carrier: 'torrestir', confidence: 'high' });
      expect(recognitionCandidates(record.number), record.number).toEqual([]);
    }
    // The tracker does not open a guia reference, so the adapter does not take one.
    for (const record of numbers.records.filter((entry) => entry.expect.carrier !== 'torrestir')) {
      expect(() => normalizeTorrestirNumber(record.number), record.number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(parseTrackingInput(`https://tracking.torrestir.com/?id=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'torrestir' });
  });
});

describe('Torrestir status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(statuses.entries).toHaveLength(29);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(torrestirStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'torrestir', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'torrestir', description: 'Nota sintética' })).toEqual({ kind: 'unknown' });
    expect(torrestirStage('Nota sintética')).toBeNull();
  });
});
