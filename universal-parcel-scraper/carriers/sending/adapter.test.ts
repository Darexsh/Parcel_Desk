import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SENDING_LOOKUP, SendingTracker } from './adapter.js';
import { normalizeSendingNumber, parseSending } from './parser.js';
import { isSendingNotice, sendingMappedStage, sendingScan, sendingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123400000011';
const IN_TRANSIT = '123400000022';
const MISSING = '123400000033';
const UNKNOWN = '123400000044';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = page('delivered');
const notFound = page('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
const SESSION = 'JSESSIONID=10.0.0.1:8080~SyntheticSession-0001.master:backend9';
const ANSWER = '/fgts/priv/expediciones/tracking_expedicion_seguimiento.seam';
const ABSENT = '/fgts/no_encontrado_2.seam';
const redirect = (path = ANSWER, cookie: string | null = `${SESSION}; path=/fgts`) => new Response(null, { status: 302, headers: {
  Location: `https://info.sending.es${path};jsessionid=SyntheticSession-0001.master:backend9?cid=101`, ...(cookie ? { 'Set-Cookie': cookie } : {}),
} });
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
/** The tracker's two answers: the lookup's redirect, then the page it points to. */
const tracker = (body: string, path = ANSWER) => vi.fn<typeof fetch>().mockResolvedValueOnce(redirect(path)).mockResolvedValueOnce(reply(body));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Sending tracking adapter', () => {
  it('posts the number as the search form does, then reads the answer page in the session the lookup opened', async () => {
    const fetcher = tracker(delivered);
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SendingTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 0000 0011 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookup] = fetcher.mock.calls[0]!;
    expect(String(lookupUrl)).toBe(SENDING_LOOKUP);
    expect(lookup).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `localizador=${DELIVERED}`,
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' } });
    const [answerUrl, answer] = fetcher.mock.calls[1]!;
    // The session goes in its cookie, not in the address.
    expect(String(answerUrl)).toBe(`https://info.sending.es${ANSWER}?cid=101`);
    expect(answer).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0', Cookie: SESSION } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sending', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history as wall clocks, without the receipt, the reference, the addresses or the branch codes', () => {
    const result = normalizeCarrierResult(parseSending(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'El envio ha sido entregado', last_update: null, last_update_local: '2026-09-14T14:00:00', expected_delivery: null });
    expect(result.provider_code).toBeUndefined();
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-09-14T14:00:00', 'El envio ha sido entregado', 'Villaejemplo', 'delivered', 'carrier_map'],
      ['2026-09-14T13:59:00', 'Tu envio esta en reparto', 'Villaejemplo', 'out_for_delivery', 'carrier_map'],
      ['2026-09-14T13:59:00', 'El envio ha llegado a tu delegacion mas cercana', 'Villaejemplo', 'in_transit', 'carrier_map'],
      ['2026-09-11T19:36:00', 'Has sido ausente', 'Villaejemplo', 'failed_attempt', 'carrier_map'],
      // The recipient's correction keeps the stage of the scan before it.
      ['2026-09-11T12:21:00', 'Direccion corregida por el destinatario', 'Villaejemplo', 'out_for_delivery', 'none'],
      ['2026-09-11T11:28:00', 'Tu envio esta en reparto', 'Villaejemplo', 'out_for_delivery', 'carrier_map'],
      ['2026-09-11T11:26:00', 'El envio ha llegado a tu delegacion mas cercana', 'Villaejemplo', 'in_transit', 'carrier_map'],
      ['2026-09-11T01:05:00', 'Salida en ruta nacional', 'Puerto Muestra', 'in_transit', 'carrier_map'],
      ['2026-09-09T15:17:00', 'Mercancia recogida', 'Ciudad Ficticia', 'accepted', 'carrier_map'],
    ]);
    expect(result.events?.every(event => !event.time && !event.provider_code)).toBe(true);
    const json = JSON.stringify(result);
    for (const kept of ['Recibido', 'papeler', '00000', '99999', 'Aldea Privada', '(450)', '450', 'TURNO', 'VILLAEJEMPLO']) expect(json, kept).not.toContain(kept);
  });

  it('reads a parcel still on its rounds, keeping a day without a clock as the day alone', () => {
    const result = parseSending(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Tu envio esta en reparto', last_update_local: '2026-10-16T09:46:00' });
    expect(result.events?.map(event => [event.local_time, event.stage])).toEqual([
      ['2026-10-16T09:46:00', 'out_for_delivery'], ['2026-10-16T09:45:00', 'in_transit'], ['2026-10-16T00:06:00', 'failed_attempt'],
      ['2026-10-15T09:34:00', 'out_for_delivery'], ['2026-10-15', 'in_transit'],
      ['2026-10-14T01:05:00', 'in_transit'], ['2026-10-14T00:50:00', 'in_transit'], ['2026-10-13T18:45:00', 'accepted'],
    ]);
    // The sender's reference and the delivery options are not kept.
    expect(JSON.stringify(result)).not.toMatch(/REF0000001|Vecino|Corregir|Caserio|00001/);
  });

  it('takes the rail\'s end phase over the last scan: a parcel written off as missing, or delivered without its scan', () => {
    const missing = parseSending(page('missing'), MISSING);
    expect(missing).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      provider_code: 'FALT', last_status_text: 'FALTA DEFINITIVA', last_update_local: '2026-09-03T20:00:00' });
    expect(missing.events?.[0]).toMatchObject({ description: 'Has sido ausente', stage: 'failed_attempt' });
    expect(missing.events?.[2]).toMatchObject({ local_time: '2026-09-03', stage: 'in_transit' });
    const unscanned = edit($ => $('#tracking tr').slice(1, 3).remove());
    expect(parseSending(unscanned, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'ENTR',
      last_status_text: 'Entregada', last_update_local: '2026-09-14T13:59:00' });
    // The rail's other phases are coarser than the scans.
    const collected = edit($ => {
      $('#tracking tr').slice(0, -2).remove();
      $('script').last().text($('script').last().text().replace('"ENTR"', '"TRANS"'));
    });
    expect(parseSending(collected, DELIVERED)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Mercancia recogida' });
  });

  it("reads the tracker's not-found page as not found, and recognizes by the same lookup", async () => {
    await expect(carrier(tracker(notFound, ABSENT)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker(notFound, ABSENT)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(tracker(delivered)).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    for (const body of [edit($ => $('.textosNoEncontrado').text('Servicio no disponible'), notFound), edit($ => $('#noEncontrado').remove(), notFound)]) {
      expect(() => parseSending(body, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the answer to the whole number: another shipment is inconclusive, never this one', async () => {
    // The tracker also finds a shipment by another of its references.
    const other = edit($ => $('#header-text h2').text('123400000099'));
    await expect(carrier(tracker(other)).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(tracker(other)).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseSending(delivered, '123400000012')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a number Sending does not issue without a request', async () => {
    expect(normalizeSendingNumber('1234-0000-0011')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '12345', '12340000001', '1234000000111', 'ABCD00000011', 'JJD000390007843775', `${'1'.repeat(70)}`]) {
      expect(() => normalizeSendingNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a bot check as a challenge and a refusal as one too', async () => {
    await expect(carrier(tracker(CHECK)).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('Forbidden', 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps a rate limit as a rate limit', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(carrier(limited).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    const later = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(carrier(later).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('reads a changed page, a strange redirect or a lost session as a failure, never as not found', async () => {
    const changed = [
      '<html><body>Mantenimiento</body></html>',
      edit($ => $('#header-text h1').text('Otro título')),
      edit($ => $('#header-text h2').text('No disponible')),
      edit($ => $('script').last().remove()),
      edit($ => $('#tracking td.date').first().text('14/09/2026')),
      edit($ => $('#tracking td.time').first().text('2 pm')),
      edit($ => $('#tracking td.info h1').first().text('')),
      edit($ => $('#tracking td.date').first().parent().remove()),
      edit($ => $('#tracking table').clone().appendTo('#tracking')),
    ];
    for (const body of changed) {
      expect(() => parseSending(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = edit($ => $('#tracking tr').remove());
    expect(() => parseSending(empty, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const receiptOnly = edit($ => $('#tracking tr').not(':nth-child(1), :nth-child(3)').remove());
    expect(() => parseSending(receiptOnly, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));

    const session = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValueOnce(reply(delivered));
    const failures: [Response, string][] = [
      [redirect('/fgts/login.seam'), 'indeterminate'],
      [redirect('/fgts/otra_pagina.seam'), 'schema'],
      [new Response(null, { status: 302, headers: { Location: 'https://example.invalid/fgts/no_encontrado_2.seam?cid=1', 'Set-Cookie': SESSION } }), 'schema'],
      [new Response(null, { status: 302, headers: { Location: `https://info.sending.es${ABSENT}?cid=1&numero=1`, 'Set-Cookie': SESSION } }), 'schema'],
      [new Response(null, { status: 302, headers: { 'Set-Cookie': SESSION } }), 'schema'],
      [redirect(ANSWER, null), 'indeterminate'],
      [reply('Not found', 404), 'indeterminate'],
    ];
    for (const [response, kind] of failures) {
      await expect(carrier(session(response)).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    }
    const signIn = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(new Response(null, { status: 302,
      headers: { Location: 'https://info.sending.es/fgts/login.seam?cid=102' } }));
    await expect(carrier(signIn).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('tries once more in a new session when the tracker cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(redirect()).mockResolvedValueOnce(reply(delivered));
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });

  it('maps every wording it recorded, leaves notices without a stage, and answers the app by wording', () => {
    for (const entry of statuses.entries.filter(entry => !('code' in entry) && entry.confirmedBy === 'portal')) {
      if ('stage' in entry) expect(sendingMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      else expect(sendingMappedStage(entry.wording), entry.wording).toBeUndefined();
    }
    expect(isSendingNotice('DIRECCIÓN CORREGIDA POR EL DESTINATARIO')).toBe(true);
    expect(sendingStage('Direccion corregida por el destinatario')).toBeNull();
    // Another wording falls to the shared rules.
    expect(sendingStage('Envío entregado')).toMatchObject({ stage: 'delivered' });
    for (const word of ['constructor', 'toString', 'Sin estado']) expect(sendingMappedStage(word)).toBeUndefined();
    expect(statusMap.stage(null, 'tu envio esta en reparto')).toBe('out_for_delivery');
    expect(statusMap.stage('ENTR', 'tu envio esta en reparto')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'sending', providerCode: null, description: 'El envio ha sido entregado' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'sending', providerCode: null, description: 'Direccion corregida por el destinatario' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
  });

  it("stores an aggregator's English for a scan in the tracker's own wording, at the tracker's stage", () => {
    expect(sendingScan('Reception in the delegation')).toEqual({ stage: 'accepted', wording: 'Mercancia recogida' });
    expect(sendingScan('OUT IN NATIONAL ROUTE')).toEqual({ stage: 'in_transit', wording: 'Salida en ruta nacional' });
    expect(sendingScan('Mercancia recogida')).toEqual({ stage: 'accepted', wording: 'Mercancia recogida' });
    expect(sendingScan('Reception in the warehouse')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'sending', providerCode: null, description: 'Reception in the delegation' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sending', providerCode: null, description: 'Out in national route' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});

describe('Sending numbers', () => {
  it('suggests twelve digits and is asked about them only for a lookup in Spain, Portugal or Andorra', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown' });
    expect(detectCarrierMatch(DELIVERED).candidates).toContain('sending');
    for (const countryHint of ['ES', 'PT', 'AD']) {
      expect(recognitionAskedCarriers(DELIVERED, { countryHint })[0], countryHint).toBe('sending');
    }
    for (const countryHint of [undefined, 'FR', 'IT', 'US']) {
      expect(recognitionAskedCarriers(DELIVERED, { countryHint }), `${countryHint}`).not.toContain('sending');
    }
    for (const other of ['12340000001', '1234000000111', 'ES1234000000']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('sending');
    }
  });
});
