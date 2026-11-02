import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_PT_TRACKER, dpdPtLookupUrl, DpdPtTracker } from './adapter.js';
import { normalizeDpdPtNumber, parseDpdPt } from './parser.js';
import { dpdPtMappedStage, dpdPtStage, isDpdPtNotice, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '09990000000101';
const AT_POINT = '09990000000202';
const IN_TRANSIT = '09990000000303';
const UNKNOWN = '09990000000404';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = page('delivered');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
type Row = readonly [code: string, day: string, time: string, wording: string, comment?: string];
// Rows newest first, as the page lists them.
const history = (...rows: Row[]) => edit($ => $('tbody').html(rows.map(([code, day, time, wording, comment = '']) =>
  `<tr><td>${code}</td><td>${day}</td><td>${time}</td><td>${wording}</td><td>${comment}</td><td class="map-link"></td></tr>`).join('')));
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const stages = (body: string, number = DELIVERED) => parseDpdPt(body, number).events!.map(event => [event.provider_code, event.stage]);

describe('DPD Portugal tracking adapter', () => {
  it('asks the tracker for the parcel number once, as its search form does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(delivered));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // Typed with the label's check character, in lower case and with spaces.
    await expect(new DpdPtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0999 0000 0001 01z ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DPD_PT_TRACKER}?reference=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('asks the page the old address now redirects to, over the global fetch without a fetcher', async () => {
    expect(dpdPtLookupUrl(DELIVERED)).toBe(`https://tracking.dpd.pt/?reference=${DELIVERED}`);
    const global = vi.fn<typeof fetch>().mockImplementation(async () => reply(delivered));
    vi.stubGlobal('fetch', global);
    try {
      await expect(new DpdPtTracker().fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(String(global.mock.calls[0]![0])).toBe(dpdPtLookupUrl(DELIVERED));
  });

  it('reads a delivered history as wall clocks, newest first, without the receiver, the window, the map or the proof', () => {
    const result = normalizeCarrierResult(parseDpdPt(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'PROVA DE ENTREGA', last_update: null, last_update_local: '2026-03-05T11:30:00', expected_delivery: null });
    expect(result.pickup_point).toBeUndefined();
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-03-05T11:30:00', 'POD', 'PROVA DE ENTREGA', 'delivered', 'carrier_map'],
      // Messages to the recipient keep the stage of the scan before them.
      ['2026-03-05T10:51:00', '709', 'MENSAGEM "A PROXIMA ENTREGA" ENVIADA', 'out_for_delivery', 'none'],
      ['2026-03-05T09:01:00', '706', 'HORÁRIO DE ENTREGA ENVIADA AO DESTINATÁRIO', 'out_for_delivery', 'none'],
      // The page lists this van scan twice.
      ['2026-03-05T07:50:00', 'OFD', 'EM DISTRIBUIÇÃO', 'out_for_delivery', 'carrier_map'],
      ['2026-03-04T18:05:00', '402', 'RETORNO ARMAZÉM PARA ENTREGA', 'in_transit', 'carrier_map'],
      ['2026-03-04T14:25:00', '506', 'AUSÊNCIA DO DESTINATÁRIO', 'failed_attempt', 'carrier_map'],
      ['2026-03-04T08:37:00', 'OFD', 'EM DISTRIBUIÇÃO', 'out_for_delivery', 'carrier_map'],
      ['2026-03-03T21:26:00', 'PEC', 'ENTRADA EM ARMAZÉM', 'in_transit', 'carrier_map'],
      ['2026-03-03T02:52:00', 'HUB', 'PASSAGEM POR HUB', 'in_transit', 'carrier_map'],
      ['2026-03-02T19:10:00', 'INB', 'ENTRADA EM ARMAZÉM', 'in_transit', 'carrier_map'],
      // The courier's collection hands on the parcel the pickup point took in from the sender.
      ['2026-03-02T18:40:00', 'COL', 'ENCOMENDA RECOLHIDA', 'in_transit', 'carrier_map'],
      ['2026-03-02T16:20:00', '012', 'ENTREGUE À DPD PELO PONTO DE ENTREGA', 'in_transit', 'carrier_map'],
      ['2026-03-01T18:28:00', '007', 'DEPOSITADO PELO CLIENTE/EXPEDIDOR', 'accepted', 'carrier_map'],
    ]);
    expect(result.events?.every(event => !event.time && !event.location && !event.point)).toBe(true);
    const json = JSON.stringify(result);
    for (const kept of ['ANA EXEMPLO', '10:45', 'REF0000001', '999', '38.7', 'example.invalid']) expect(json, kept).not.toContain(kept);
  });

  it('reads a parcel waiting at a pickup point with the point the pickup point scan names', () => {
    const result = parseDpdPt(page('at-pickup-point'), AT_POINT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'RECEPCIONADO PELO PONTO DE ENTREGA', last_update_local: '2026-10-13T15:30:00', pickup_point: 'PAPELARIA EXEMPLO' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['002', 'ready_for_pickup'], ['001', 'ready_for_pickup'], ['521', 'failed_attempt'], ['OFD', 'out_for_delivery'],
      ['PEC', 'in_transit'], ['HUB', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toContain('PT00001');
    // The recipient's collection there names the point; a door delivery after it does not.
    const collected = history(['POD', '14-10-2026', '15:52', 'PROVA DE ENTREGA', 'RECIPIENT'], ['706', '14-10-2026', '09:00', 'HORÁRIO DE ENTREGA ENVIADA AO DESTINATÁRIO'],
      ['002', '13-10-2026', '18:45', 'RECEPCIONADO PELO PONTO DE ENTREGA', 'LOJA EXEMPLO'], ['001', '13-10-2026', '18:21', 'ENTREGUE PELA DPD NO PONTO DE ENTREGA', 'PT00002']);
    expect(parseDpdPt(collected, DELIVERED)).toMatchObject({ current_stage: 'delivered', pickup_point: 'LOJA EXEMPLO' });
    const door = history(['POD', '15-10-2026', '11:00', 'PROVA DE ENTREGA'], ['OFD', '15-10-2026', '08:00', 'EM DISTRIBUIÇÃO'],
      ['002', '13-10-2026', '18:45', 'RECEPCIONADO PELO PONTO DE ENTREGA', 'LOJA EXEMPLO']);
    expect(parseDpdPt(door, DELIVERED).pickup_point).toBeUndefined();
    const unnamed = history(['002', '13-10-2026', '18:45', 'RECEPCIONADO PELO PONTO DE ENTREGA']);
    expect(parseDpdPt(unnamed, DELIVERED)).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(parseDpdPt(unnamed, DELIVERED).pickup_point).toBeUndefined();
  });

  it('reads a parcel back at the depot after a failed attempt, keeping a request without a stage', () => {
    const result = parseDpdPt(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ENVIO EM ARMAZÉM',
      last_update_local: '2026-10-15T18:44:00' });
    expect(result.events?.map(event => [event.provider_code, event.description, event.stage, event.stage_source])).toEqual([
      ['743', 'PEDIDO DE ALTERAÇÃO DE MORADA', 'in_transit', 'none'],
      ['410', 'ENVIO EM ARMAZÉM', 'in_transit', 'carrier_map'],
      ['403', 'RETORNO ARMAZÉM (PÁRA AEP)', 'in_transit', 'carrier_map'],
      ['501', 'ENDEREÇO DO DESTINATÁRIO INCOMPLETO OU ILEGÍVEL', 'failed_attempt', 'carrier_map'],
      ['OFD', 'EM DISTRIBUIÇÃO', 'out_for_delivery', 'carrier_map'],
      ['PEC', 'ENTRADA EM ARMAZÉM', 'in_transit', 'carrier_map'],
      ['HUB', 'PASSAGEM POR HUB', 'in_transit', 'carrier_map'],
      ['HUB', 'PASSAGEM POR HUB', 'in_transit', 'carrier_map'],
      ['INB', 'ENTRADA EM ARMAZÉM', 'in_transit', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/FALTA NR PORTA|SAC|"NL"/);
  });

  it('stages collections by the scans before them and a delivery after an ordered return as returned', () => {
    expect(stages(history(['COL', '14-10-2026', '16:11', 'ENCOMENDA RECOLHIDA', 'REF0000002']))).toEqual([['COL', 'accepted']]);
    // Nobody collected the parcel at the point, so it went back to the sender.
    const returned = history(['POD', '14-08-2026', '15:33', 'PROVA DE ENTREGA', 'SENDER'], ['OFD', '14-08-2026', '08:24', 'EM DISTRIBUIÇÃO'],
      ['424', '13-08-2026', '10:58', 'DEVOLUÇÃO AO EXPEDIDOR'], ['012', '12-08-2026', '10:16', 'ENTREGUE À DPD PELO PONTO DE ENTREGA'],
      ['008', '11-08-2026', '00:05', 'DATA DE PERMANÊNCIA EM LOJA EXPIRADA'], ['002', '04-08-2026', '10:28', 'RECEPCIONADO PELO PONTO DE ENTREGA', 'LOJA EXEMPLO']);
    expect(parseDpdPt(returned, DELIVERED)).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'PROVA DE ENTREGA' });
    expect(parseDpdPt(returned, DELIVERED).pickup_point).toBeUndefined();
    expect(stages(returned)).toEqual([['POD', 'returned'], ['OFD', 'out_for_delivery'], ['424', 'exception'], ['012', 'in_transit'],
      ['008', 'exception'], ['002', 'ready_for_pickup']]);
    const sentBack = history(['611', '18-09-2026', '09:44', 'ENCOMENDA DEVOLVIDA AO EXPEDIDOR', 'PT00'], ['POD', '09-09-2026', '17:13', 'PROVA DE ENTREGA']);
    expect(parseDpdPt(sentBack, DELIVERED)).toMatchObject({ current_stage: 'returned', last_status_text: 'ENCOMENDA DEVOLVIDA AO EXPEDIDOR' });
    // A code the map does not know falls to the wording rules, else has no stage.
    const unmapped = history(['999', '15-10-2026', '10:00', 'ENTREGUE'], ['998', '15-10-2026', '09:00', 'SAMPLE EVENT'],
      ['706', '15-10-2026', '08:30', 'HORÁRIO DE ENTREGA ENVIADA AO DESTINATÁRIO']);
    const result = parseDpdPt(unmapped, DELIVERED);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    expect(result.events?.[1]?.stage).toBeUndefined();
    expect(result.events?.[2]).toMatchObject({ stage: 'registered', stage_source: 'none' });
    expect(result).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(parseDpdPt(history(['998', '15-10-2026', '09:00', 'SAMPLE EVENT']), DELIVERED)).toMatchObject({ status: 'unknown',
      last_status_text: 'SAMPLE EVENT', last_update_local: '2026-10-15T09:00:00' });
  });

  it('leaves out the expected delivery day, which is dated when DPD set it', () => {
    const forecast = history(['714', '20-10-2026', '16:25', 'DATA PREVISTA DE ENTREGA'], ['INB', '20-10-2026', '16:09', 'ENTRADA EM ARMAZÉM']);
    expect(parseDpdPt(forecast, DELIVERED)).toMatchObject({ last_status_text: 'ENTRADA EM ARMAZÉM', last_update_local: '2026-10-20T16:09:00' });
    expect(stages(forecast)).toEqual([['INB', 'in_transit']]);
    expect(() => parseDpdPt(history(['714', '20-10-2026', '16:25', 'DATA PREVISTA DE ENTREGA']), DELIVERED))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the page’s notice for an unknown number as not found, and an empty table as no history', async () => {
    expect(() => parseDpdPt(page('not-found'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => parseDpdPt(page('not-found').replace('No results were found', 'Erro'), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The notice in Portuguese, under the heading without its colon, as the page wrote both before.
    const portuguese = page('not-found').replace('No results were found for', 'Não encontrámos resultados para')
      .replace('Nº de encomenda: ', 'Nº de encomenda');
    expect(() => parseDpdPt(portuguese, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // The page answers some references with an empty table and neither scans nor a notice.
    expect(() => parseDpdPt(history(), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads a bot check, whatever its status, as a challenge', async () => {
    expect(() => parseDpdPt(CHECK, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const status of [200, 403]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it('binds the page to the whole number asked', () => {
    for (const other of [IN_TRANSIT, `${DELIVERED}Z`, DELIVERED.slice(1), '']) {
      for (const heading of [`Nº de encomenda: ${other}`, `Nº de encomenda${other}`]) {
        const body = edit($ => $('.reference-label span').text(heading));
        expect(() => parseDpdPt(body, DELIVERED), heading).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
      }
    }
    expect(parseDpdPt(edit($ => $('.reference-label span').text(`Nº de encomenda${DELIVERED}`)), DELIVERED).status).toBe('delivered');
    const notice = page('not-found').replace(`found for ${UNKNOWN}`, `found for ${IN_TRANSIT}`);
    expect(() => parseDpdPt(notice, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed pages and bounds the history', () => {
    for (const body of [
      edit($ => $('.reference-label').remove()), edit($ => $('.reference-label').clone().appendTo('body')),
      edit($ => $('.reference-label span').text(`Reference ${DELIVERED}`)), edit($ => $('table').clone().appendTo('.trace')),
      edit($ => $('table').remove()), edit($ => $('thead th').eq(1).text('Day')), edit($ => $('tbody tr').first().children('td').last().remove()),
      history(['POD', '31-02-2026', '11:30', 'PROVA DE ENTREGA']), history(['POD', '2026-03-05', '11:30', 'PROVA DE ENTREGA']),
      history(['POD', '05-03-2026', '24:00', 'PROVA DE ENTREGA']), history(['', '05-03-2026', '11:30', 'PROVA DE ENTREGA']),
      history(['P-D', '05-03-2026', '11:30', 'PROVA DE ENTREGA']), history(['POD', '05-03-2026', '11:30', '']),
      history(...Array.from({ length: 501 }, (_, index) => ['HUB', '05-03-2026', `1${index % 10}:${String(index % 60).padStart(2, '0')}`, 'PASSAGEM POR HUB'] as const)),
      '<html><body><p>Site em manutenção</p></body></html>', '',
    ]) {
      expect(() => parseDpdPt(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: expect.stringMatching(/^(?:schema|indeterminate)$/) }));
    }
    const long = history(...Array.from({ length: 150 }, (_, index) => ['HUB', `${String(28 - Math.floor(index / 60)).padStart(2, '0')}-02-2026`,
      `${String(23 - Math.floor((index % 60) / 10)).padStart(2, '0')}:${String(59 - (index % 10)).padStart(2, '0')}`, 'PASSAGEM POR HUB'] as const));
    const result = parseDpdPt(long, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-02-28T23:59:00' });
  });

  it('takes DPD parcel numbers, with or without a matching check character, and nothing else, without a request', async () => {
    expect(normalizeDpdPtNumber(' 0999-0000-0001-01 ')).toBe(DELIVERED);
    expect(normalizeDpdPtNumber(`${AT_POINT}r`)).toBe(AT_POINT);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [`${DELIVERED}A`, DELIVERED.slice(1), `${DELIVERED}0`.repeat(2), '1050174241169U', 'ZZ000000014PT', '', '0'.repeat(80)]) {
      expect(() => normalizeDpdPtNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered)).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(history()));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T11:30:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too many requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [302, 'transport'], [404, 'indeterminate'], [410, 'indeterminate'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(delivered));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(delivered));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('offers another network’s depot numbers, asked with a Portuguese hint, after its own depots', () => {
    const checked = (digits: string) => `${digits}${[...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(character => dpdParcelNumber(`${digits}${character}`))!}`;
    for (const number of ['01500000000000', '28840000000000', checked('01500000000000')]) {
      const match = detectCarrierMatch(number);
      expect(match.candidates, number).toContain('dpd-pt');
      expect(match.preferred, number).not.toContain('dpd-pt');
      expect(recognitionAskedCarriers(number, { countryHint: 'PT' }).slice(0, 2), number).toContain('dpd-pt');
      expect(recognitionAskedCarriers(number, { countryHint: 'IT' }), number).not.toContain('dpd-pt');
    }
    for (const countryHint of [undefined, 'DE', 'ES', 'FR', 'GB', 'NL']) {
      expect(recognitionAskedCarriers('01500000000000', { countryHint }), countryHint).not.toContain('dpd-pt');
    }
    expect(detectCarrierMatch('09600000000000')).toMatchObject({ preferred: ['dpd-pt'] });
    expect(recognitionAskedCarriers('09600000000000')[0]).toBe('dpd-pt');
  });

  it('routes a parcel filed under DPD Portugal to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(delivered));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dpd-pt' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dpd-pt', source: 'dpd-pt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === dpdPtLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('DPD Portugal status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it, and leaves notices without one', () => {
    for (const entry of statuses.entries) {
      const stage = (entry as { stage?: string }).stage;
      expect(dpdPtMappedStage(entry.code), entry.code).toBe(stage);
      expect(isDpdPtNotice(entry.code), entry.code).toBe(stage === undefined);
      const answer = statusMapAnswer({ carrier: 'dpd-pt', providerCode: entry.code, description: entry.wording });
      if (stage === undefined) expect(answer, entry.code).toMatchObject({ kind: 'intentional_gap' });
      // A collection and a delivery take their stage from the scans before them.
      else if (entry.code === 'COL' || entry.code === 'POD') expect(answer, entry.code).toEqual({ kind: 'unknown' });
      else expect(answer, entry.code).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMap.stage(null, 'prova de entrega')).toBeUndefined();
    expect(dpdPtStage('pod', 'PROVA DE ENTREGA')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(dpdPtStage('706', 'ENTREGUE')).toBeNull();
    for (const code of ['constructor', 'toString', '']) expect(dpdPtMappedStage(code), code).toBeUndefined();
  });
});
