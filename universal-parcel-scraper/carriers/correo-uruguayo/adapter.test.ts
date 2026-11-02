import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CORREO_URUGUAYO_API, CorreoUruguayoTracker } from './adapter.js';
import { normalizeCorreoUruguayoNumber, parseCorreoUruguayo } from './parser.js';
import { correoUruguayoEventStage, correoUruguayoStage, statusMap, summaryStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RR000000014UY';
const IN_TRANSIT = 'CP000000028UY';
const UNKNOWN = 'RR000000031UY';
const INBOUND = 'LX000000045CN';
const INVALID = 'ZZ000000014UY';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Scan = Record<string, unknown>;
type Item = Record<string, unknown> & { eventos: Scan[] };
const fixture = (name: string): Item[] => JSON.parse(text(name)) as Item[];
const edited = (name: string, change: (item: Item, payload: Item[]) => void): Item[] => {
  const payload = fixture(name);
  change(payload[0]!, payload);
  return payload;
};
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Correo Uruguayo tracking adapter', () => {
  it('asks the tracker for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreoUruguayoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 000 000 014 uy ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORREO_URUGUAYO_API}?codigoPieza=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correo-uruguayo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with each scan’s wall clock, office and code, and without the recipient', () => {
    const result = parseCorreoUruguayo(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-04-09T11:05:00', expected_delivery: null });
    // The international exchange's copy of the delivery, in the same minute, is kept once.
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-04-09T11:05:00', 'Sucursal Muestra, SUC, VILLA EJEMPLO', 'ENTREGADO', '16', 'delivered'],
      ['2026-04-09T08:12:00', 'Sucursal Muestra, SUC, VILLA EJEMPLO', 'ASIGNADO A DISTRIBUCION', '4', 'out_for_delivery'],
      ['2026-04-08T19:40:00', 'Planta de Muestra, VILLA EJEMPLO', 'PROCESADO EN OFICINA', '12', 'in_transit'],
      ['2026-04-08T10:02:00', 'Oficina Ejemplo, PUEBLO MUESTRA', 'EN TRANSITO A DESTINO', '1', 'in_transit'],
      ['2026-04-07T15:09:00', 'Oficina Ejemplo, PUEBLO MUESTRA', 'INGRESO A CORREO URUGUAYO', '15', 'accepted'],
    ]);
    // The reply names no zone, so no scan gets an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/MARIA|0\.000|SAMPLE|RUTA|XX|TYT|IPS/);
    const kept = new Set(['local_time', 'location', 'description', 'provider_code', 'stage', 'stage_source']);
    expect(result.events!.flatMap((event) => Object.keys(event)).filter((key) => !kept.has(key))).toEqual([]);
    expect(result).not.toHaveProperty('international_tracking_number');
    const attempt = parseCorreoUruguayo(edited('delivered', (item) => {
      item.eventos = item.eventos.slice(2);
      item.eventos.unshift({ ...item.eventos[0]!, fecha: '09/04/2026 12:30', evento: 'INTENTO DE ENTREGA: SAMPLE 0.000.000-0', codigoevento: '36' });
      item.codigoEtapaEntrega = 'EN_PROCESO_ENTREGA';
    }), DELIVERED);
    expect(attempt).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'INTENTO DE ENTREGA' });
    expect(JSON.stringify(attempt)).not.toMatch(/SAMPLE|0\.000/);
  });

  it('reads an item between offices as in transit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PROCESADO EN OFICINA', last_update_local: '2026-05-12T22:27:00',
      events: [{ location: 'Planta de Muestra, VILLA EJEMPLO' }, { location: 'Sucursal Ejemplo EJEM, PUEBLO MUESTRA' }, {}, { stage: 'accepted' }] });
    expect(result.events).toHaveLength(4);
  });

  it('reads mail from abroad under its own code, with the sending post’s scans, and reports the code the post gave it', () => {
    const result = parseCorreoUruguayo(fixture('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      canonical_tracking_number: 'CP000000059UY', last_update_local: '2026-02-19T09:12:00',
      last_status_text: 'ENVÍO RETENIDO POR ORGANISMO DE CONTRALOR. (EJ. ADUANA, MSP, MGAP).' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-02-19T09:12:00', 'CENTRO DE MUESTRA, URUGUAY', 'ENVÍO RETENIDO POR ORGANISMO DE CONTRALOR. (EJ. ADUANA, MSP, MGAP).', '34', 'customs'],
      ['2026-02-19T09:11:00', 'CENTRO DE MUESTRA, URUGUAY', 'ENVIADO A ORGANISMO DE CONTRALOR (EJ. ADUANA, MSP, MGAP)', '31', 'customs'],
      ['2026-02-17T18:30:00', 'CENTRO DE MUESTRA, URUGUAY', 'RECEPCION DE ENVIO EN PLANTA DE PROCESAMIENTO INTERNACIONAL', '30', 'in_transit'],
      ['2026-02-16T12:03:00', 'AEROPUERTO DE MUESTRA, URUGUAY', 'LLEGADA DE CONTENEDOR A URUGUAY', '130', 'in_transit'],
      // Code 12 is a departure here and an office's processing in the domestic history.
      ['2026-02-08T17:05:00', 'CHINA', 'SALIDA DE ORIGEN', '12', 'in_transit'],
      ['2026-02-06T02:17:00', 'CHINA', 'PROCESADO EN OFICINA DE ORIGEN', '8', 'in_transit'],
      ['2026-02-05T12:01:00', 'CHINA', 'ADMISION PAIS DE ORIGEN', '1', 'accepted'],
    ]);
    // The sending post's scans keep its own wall clock.
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // Asked under the post's own code, the item reports the one it came with.
    expect(parseCorreoUruguayo(fixture('inbound'), 'CP000000059UY')).toMatchObject({ international_tracking_number: INBOUND });
    expect(parseCorreoUruguayo(edited('inbound', (item) => { item.idNacional = null; }), INBOUND)).not.toHaveProperty('canonical_tracking_number');
  });

  it('turns an oldest-first history round, keeps a repeated scan once and keeps the newest stage under an unknown wording', () => {
    const clocks = (result: { events?: { local_time?: unknown; description?: unknown }[] }) => result.events!.map((event) => [event.local_time, event.description]);
    const reversed = parseCorreoUruguayo(edited('delivered', (item) => { item.eventos.reverse(); }), DELIVERED);
    expect(clocks(reversed)).toEqual(clocks(parseCorreoUruguayo(fixture('delivered'), DELIVERED)));
    const repeated = parseCorreoUruguayo(edited('delivered', (item) => { item.eventos.splice(2, 0, { ...item.eventos[2]!, codigoevento: '39' }); }), DELIVERED);
    expect(repeated.events).toHaveLength(5);
    // The same wording in another minute is another scan.
    const again = parseCorreoUruguayo(edited('delivered', (item) => { item.eventos.splice(2, 0, { ...item.eventos[2]!, fecha: '09/04/2026 08:17' }); }), DELIVERED);
    expect(again.events!.map((event) => event.description)).toEqual(['ENTREGADO', 'ASIGNADO A DISTRIBUCION', 'ASIGNADO A DISTRIBUCION',
      'PROCESADO EN OFICINA', 'EN TRANSITO A DESTINO', 'INGRESO A CORREO URUGUAYO']);
    const unknown = parseCorreoUruguayo(edited('in-transit', (item) => {
      item.eventos.unshift({ fecha: '13/05/2026 08:00', evento: 'EVENTO DE MUESTRA', ubicacion: null, codigoevento: 99 });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'EVENTO DE MUESTRA',
      last_update_local: '2026-05-13T08:00:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-13T08:00:00', description: 'EVENTO DE MUESTRA', provider_code: '99' });
  });

  it('keeps scans of one minute in the reply’s order, whichever way it lists them', () => {
    const tied = (reversed: boolean) => parseCorreoUruguayo(edited('delivered', (item) => {
      item.eventos.splice(2, 0, { ...item.eventos[2]!, evento: 'EVENTO DE MUESTRA', codigoevento: 99 });
      if (reversed) item.eventos.reverse();
    }), DELIVERED).events!.map((event) => event.description);
    expect(tied(true)).toEqual(tied(false));
  });

  it('takes the progress bar’s delivered step over the scans, and its other steps only when no scan has a stage', () => {
    const delivered = parseCorreoUruguayo(edited('in-transit', (item) => { item.codigoEtapaEntrega = 'ENTREGADO'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'PROCESADO EN OFICINA' });
    const unstaged = (step: string) => parseCorreoUruguayo(edited('in-transit', (item) => {
      item.eventos = [{ fecha: '13/05/2026 08:00', evento: 'EVENTO DE MUESTRA', codigoevento: '99' }];
      item.codigoEtapaEntrega = step;
    }), IN_TRANSIT);
    expect(unstaged('INICIADO')).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map' });
    expect(unstaged('EN_PROCESO_ENTREGA')).toMatchObject({ current_stage: 'in_transit' });
    const bare = unstaged('SIN_EVENTOS');
    expect(bare).toMatchObject({ status: 'unknown', last_status_text: 'EVENTO DE MUESTRA' });
    expect(bare.current_stage).toBeUndefined();
    // The scans' stage stands under a step that says no more.
    expect(parseCorreoUruguayo(edited('delivered', (item) => { item.codigoEtapaEntrega = 'EN_PROCESO_TRASLADO'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the tracker’s not-found entries as missing, an empty reply as inconclusive and a firewall page as a challenge', async () => {
    expect(() => parseCorreoUruguayo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Another post's code the tracker never saw comes back without a code.
    expect(() => parseCorreoUruguayo(fixture('not-found-inbound'), INBOUND)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCorreoUruguayo([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered').replaceAll(DELIVERED, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('reads an archived item as an expired history and a service code the post does not use as invalid input', async () => {
    expect(() => parseCorreoUruguayo(fixture('filed'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'history_expired' }));
    expect(() => parseCorreoUruguayo(fixture('invalid-product'), INVALID)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('invalid-product'))).mockResolvedValueOnce(reply(text('filed')));
    await expect(carrier(fetcher).recognize!(INVALID)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseCorreoUruguayo(fixture('delivered'), 'RR000000045UY'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Correo Uruguayo answered for a different item' }));
    expect(() => parseCorreoUruguayo(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseCorreoUruguayo(edited('delivered', (item) => { item.idNacional = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(5);
    for (const payload of [{}, null, 'SUCCESS', [null], [{ idNacional: DELIVERED }],
      edited('delivered', (item, reply) => { reply.push(item); }),
      edited('delivered', (item) => { delete item.idNacional; }),
      edited('delivered', (item) => { item.idNacional = 7; }),
      edited('delivered', (item) => { item.estado = 'SAMPLE'; }),
      edited('delivered', (item) => { (item as Record<string, unknown>).eventos = {}; }),
      edited('delivered', (item) => { (item.eventos as unknown[])[1] = 'scan'; }),
      edited('delivered', (item) => { item.eventos[1]!.evento = ' '; }),
      edited('delivered', (item) => { item.eventos[1]!.evento = ['ENTREGADO']; }),
      edited('delivered', (item) => { item.eventos[1]!.fecha = '2026-04-09 08:12'; }),
      edited('delivered', (item) => { item.eventos[1]!.fecha = '30/02/2026 08:12'; }),
      edited('delivered', (item) => { item.eventos[1]!.fecha = '09/04/2026 24:00'; }),
      edited('delivered', (item) => { item.eventos[1]!.fecha = null; }),
      edited('delivered', (item) => { item.eventos[1]!.ubicacion = 7; }),
      edited('delivered', (item) => { item.eventos[1]!.codigoevento = 'A1'; }),
      edited('delivered', (item) => { item.eventos[1]!.codigoevento = 1.5; }),
      edited('delivered', (item) => { item.eventos = Array.from({ length: 501 }, () => item.eventos[0]!); })]) {
      expect(() => parseCorreoUruguayo(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCorreoUruguayo(edited('delivered', (item) => { item.eventos = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR000000000UY', 'RR00000001UY', 'RR000000014UYX', 'R0000000014UY', '1234567890123', 'SAMPLETRACKING', `RR${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCorreoUruguayoNumber(' lx-000-000-045 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-09T11:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('',
      { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Correo Uruguayo to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'correo-uruguayo' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'correo-uruguayo', source: 'correo-uruguayo', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(CORREO_URUGUAYO_API))).toBe(true);
  });

  it('leaves Uruguayan S10 codes with the postal fallback, which asks it first, and opens its tracking links', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('correo-uruguayo');
    const link = `https://ahiva.correo.com.uy/servicioConsultaTntIps-web/SeguimientoJSNuevo?codigoPieza=${DELIVERED}`;
    expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'correo-uruguayo', source: 'link' });
  });
});

describe('Correo Uruguayo status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, whatever the code', () => {
    for (const entry of statuses.entries) {
      expect(correoUruguayoEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'correo-uruguayo', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(correoUruguayoStage(' envío  retenido por organismo de contralor. (ej. aduana, msp, mgap). ')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(correoUruguayoStage('EVENTO DE MUESTRA')).toBeNull();
    for (const wording of ['constructor', 'toString', 'ENTREGADO A', 'EVENTO DE MUESTRA']) expect(correoUruguayoEventStage(wording), wording).toBeUndefined();
    expect(summaryStage(' entregado ')).toBe('delivered');
    expect(summaryStage('SIN_EVENTOS')).toBeUndefined();
  });
});
