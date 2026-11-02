import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, REDUR_TRACKER, redurLookupBody, RedurTracker } from './adapter.js';
import { normalizeRedurNumber, parseRedur } from './parser.js';
import { redurMappedStage, redurStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000000000017';
const INTERNATIONAL = '10000000000024';
const UNKNOWN = '10000000000031';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = page('delivered');
const international = page('international');
const notFound = page('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The search form again, marked as an error, as the tracker answers a request missing a field.
const REFUSED = edit($ => {
  $('#result-track-trace').replaceWith('<div id="search-track-trace"><div class="form-track-trace error"><form id="form-track-trace" method="post">'
    + '<input type="text" name="valor"><div class="error-message"><span>Error. Introduce de nuevo la referencia</span></div></form></div></div>');
});

describe('Redur tracking adapter', () => {
  it('posts the number as the search form does, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(delivered));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RedurTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0000 17 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(REDUR_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: redurLookupBody(DELIVERED),
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body))))
      .toEqual({ 'g-recaptcha-response': '', idiomausuario: 'es', buscarpor: 'NTRACKING', valor: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'redur', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first as wall clocks, without package counts or the repeated scan', () => {
    const result = normalizeCarrierResult(parseRedur(delivered, DELIVERED));
    // The rail says delivered, whatever the later scan says.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-09-18T10:44:00', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-09-18T10:44:00', 'RECOGERÁN EN AGENCIA', 'Villa Ejemplo (pt)', 'ready_for_pickup', 'carrier_map'],
      ['2026-09-07T12:18:00', 'ENTREGA', 'Villa Ejemplo (pt)', 'delivered', 'carrier_map'],
      ['2026-09-07T08:31:00', 'SALIDA A REPARTO', 'Villa Ejemplo (pt)', 'out_for_delivery', 'carrier_map'],
      ['2026-09-04T13:05:00', 'DESTINATARIO AUSENTE', 'Villa Ejemplo (pt)', 'failed_attempt', 'carrier_map'],
      ['2026-09-04T08:47:00', 'SALIDA A REPARTO', 'Villa Ejemplo (pt)', 'out_for_delivery', 'carrier_map'],
      ['2026-09-04T06:02:00', 'ENTRADA PLAZA DESTINO', 'Villa Ejemplo (pt)', 'in_transit', 'carrier_map'],
      // Scans of one minute keep the page's order, reversed; the repeated scan is kept once.
      ['2026-09-03T01:25:00', 'SALIDA PLAZA TRANSITO', 'Nudo Central', 'in_transit', 'carrier_map'],
      ['2026-09-03T01:25:00', 'ENTRADA PLAZA TRANSITO', 'Nudo Central', 'in_transit', 'carrier_map'],
      ['2026-09-02T16:40:00', 'SALIDA PLAZA ORIGEN', 'Ciudad Muestra', 'in_transit', 'carrier_map'],
      ['2026-09-02T15:12:00', 'ENTRADA PLAZA ORIGEN', 'Ciudad Muestra', 'accepted', 'carrier_map'],
      // Midnight marks the day alone.
      ['2026-09-02', 'DOCUMENTACION', 'Ciudad Muestra', 'registered', 'carrier_map'],
    ]);
    expect(result.events?.every(event => !event.time && !event.provider_code)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toMatch(/Bultos|Recibida la información|En Redur/);
  });

  it('reads an international shipment by its scans: the partner leg keeps its places and the rail\'s other steps are not read', () => {
    const result = parseRedur(international, INTERNATIONAL);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'DESTINATARIO AUSENTE', last_update_local: '2026-09-29T11:56:00' });
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-09-29T11:56:00', 'DESTINATARIO AUSENTE', 'Internacional', 'failed_attempt'],
      ['2026-09-29T08:02:00', 'SALIDA A REPARTO', 'Cbl-', 'out_for_delivery'],
      ['2026-09-25T06:15:00', 'PENDIENTE DE FECHA CONCERTADA', 'Internacional', 'in_transit'],
      ['2026-09-24T07:30:00', 'PENDIENTE DE FECHA CONCERTADA', 'Internacional', 'in_transit'],
      ['2026-09-22T11:09:00', 'CARGA CAMION T. INTERNACIONAL', 'Puerto Ficticio', 'in_transit'],
      ['2026-09-21', 'DOCUMENTACION', 'Puerto Ficticio', 'registered'],
    ]);
    // The page names the partner's depot but not the partner's number, so there is no hand-off.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('takes a delivered rail without a delivery scan, but not a rail the page fades out', () => {
    const unscanned = edit($ => $('.seguimiento-table .table_state').slice(10).remove());
    expect(parseRedur(unscanned, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update_local: '2026-09-07T08:31:00' });
    const faded = edit($ => { $('.seguimiento-table .table_state').slice(10).remove(); $('.result-states').addClass('error-98'); });
    expect(parseRedur(faded, DELIVERED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'SALIDA A REPARTO' });
    // A rail that stops earlier leaves the stage to the scans, and a delivery scan keeps its own wording.
    const behind = edit($ => { $('#track-trace-7').removeClass('active').addClass('disabled'); $('#track-trace-6').addClass('active'); });
    expect(parseRedur(behind, DELIVERED)).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'RECOGERÁN EN AGENCIA' });
    const deliveredLast = edit($ => $('.seguimiento-table .table_state').last().remove());
    expect(parseRedur(deliveredLast, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'ENTREGA' });
  });

  it('reads the tracker\'s empty answer marked as an error as not found, and recognizes by the same lookup', async () => {
    expect(() => parseRedur(notFound, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(notFound))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(notFound))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A local clock dates the last activity without an instant.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(delivered))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-18T10:44:00' });
  });

  it('binds the answer to the whole number asked: another number is inconclusive, never this shipment', async () => {
    const other = edit($ => $('[id="envio-id"]').text('10000000000099'));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(other))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(other))).recognize!(DELIVERED))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseRedur(edit($ => $('[id="envio-id"]').last().text('10000000000099')), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRedur(delivered, '10000000000018')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRedur(notFound, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a number Redur does not issue without a request', async () => {
    expect(normalizeRedurNumber('1000-0000-0000-17')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1000000000001', '100000000000171', 'A0000000000017', 'JJD000000000000017', '1'.repeat(70)]) {
      expect(() => normalizeRedurNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a bot check as a challenge, and the Turnstile widget every page carries as nothing', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    expect(delivered).toContain('cf-turnstile');
    expect(() => parseRedur(REFUSED, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the tracker\'s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too many requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [302, 'transport'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(notFound, status));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a changed page as a failure, never as not found', () => {
    const changed = [
      '<html><body>Mantenimiento</body></html>',
      edit($ => $('[id="envio-id"]').remove()),
      edit($ => $('[id="envio-id"]').text('')),
      edit($ => $('.result-states').remove()),
      edit($ => $('.seguimiento-table').remove()),
      edit($ => $('.seguimiento-table').clone().appendTo('#seguimiento')),
      edit($ => $('.table_state').first().children('div').last().remove()),
      edit($ => $('.table_state').first().children('div').first().removeClass('title')),
      edit($ => $('.table_state').first().children('div').first().text('')),
      edit($ => $('.table_state').first().children('div').eq(1).text('2026-09-02 00:00')),
      edit($ => $('.table_state').first().children('div').eq(1).text('31/09/2026 10:00')),
      edit($ => $('.table_state').first().children('div').eq(1).text('02/09/2026 24:00')),
      edit($ => $('.table_state').first().children('div').eq(1).text('02/09/2026')),
      // Scans under the not-found mark.
      edit($ => $('.result-states').addClass('error')),
    ];
    for (const body of changed) expect(() => parseRedur(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const oversized = edit($ => { const row = $('.table_state').first(); for (let index = 0; index < 500; index += 1) row.clone().insertAfter(row); });
    expect(() => parseRedur(oversized, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // An answer without the error mark or scans is inconclusive.
    const empty = edit($ => $('.result-states').removeClass('error'), notFound);
    expect(() => parseRedur(empty, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
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
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(2_200_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a parcel filed under Redur to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(delivered));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'redur' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'redur', source: 'redur', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === REDUR_TRACKER)).toBe(true);
  });
});

describe('Redur status vocabulary', () => {
  it('maps every tracker wording it recorded to the stage recorded for it, and answers the app by wording', () => {
    for (const entry of statuses.entries.filter(entry => entry.language !== 'it')) {
      expect(redurMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'redur', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(redurMappedStage('  recogeran  en agencia ')).toBe('ready_for_pickup');
    expect(statusMap.stage('X1', 'entrega')).toBeUndefined();
    // Another wording falls to the shared rules, else gets no stage.
    expect(redurStage('Envío entregado')).toMatchObject({ stage: 'delivered' });
    expect(redurStage('Línea de ejemplo')).toBeNull();
    for (const wording of ['constructor', 'toString', '']) expect(redurMappedStage(wording), wording).toBeUndefined();
  });
});
