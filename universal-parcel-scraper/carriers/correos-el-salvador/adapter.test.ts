import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CORREOS_EL_SALVADOR_API, CorreosElSalvadorTracker } from './adapter.js';
import { isCorreosElSalvadorMissing, normalizeCorreosElSalvadorNumber, parseCorreosElSalvador } from './parser.js';
import { correosElSalvadorEventStage, correosElSalvadorStage, statusMap, summaryStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CP900000019SV';
const IN_TRANSIT = 'EE900000022SV';
const UNKNOWN = 'ZZ900000053SV';
const INBOUND = 'LX900000040CN';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Scan = Record<string, unknown>;
type Reply = Record<string, unknown> & { envio: Record<string, unknown>; eventos: Scan[] };
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (reply: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const missing = () => reply(text('not-found'), 404, 'application/problem+json; charset=utf-8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const NGINX = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('Correos de El Salvador tracking adapter', () => {
  it('asks the tracking service for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreosElSalvadorTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cp 900 000 019 sv ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORREOS_EL_SALVADOR_API}${DELIVERED}`);
    expect(String(url)).toBe(`https://www.correos.gob.sv:8000/api/v1/rastrear-paquete/${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correos-el-salvador', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with each scan’s wall clock, office and code, its weight and its destination', () => {
    const result = parseCorreosElSalvador(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregar envío (entrada)', last_update: null, last_update_local: '2026-03-04T11:20:00', expected_delivery: null,
      weight_kg: 1.25, destination_country: 'SV' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-04T11:20:00', 'OFICINA DE MUESTRA 2', 'Entregar envío (entrada)', '37', 'delivered'],
      ['2026-03-04T08:31:14', 'OFICINA DE MUESTRA 2', 'Transferir envío al agente de entrega (entrada)', '39', 'out_for_delivery'],
      ['2026-03-03T16:48:05', 'OFICINA DE MUESTRA 2', 'Recibir envío en oficina de entrega (entrada)', '32', 'in_transit'],
      ['2026-03-03T10:26:47', 'CENTRO DE EJEMPLO', 'Insertar envío en saca nacional', '13', 'in_transit'],
      ['2026-03-03T10:02:33', 'CENTRO DE EJEMPLO', 'Recibir envío en ubicación (entrada)', '33', 'in_transit'],
      ['2026-03-02T14:15:09', 'PUEBLO EJEMPLO', 'Enviar envío a ubicación nacional (salida)', '2', 'in_transit'],
      ['2026-03-02T14:14:30', 'PUEBLO EJEMPLO', 'Recibir envío del cliente (salida)', '1', 'accepted'],
    ]);
    // The reply names no zone, so no scan gets an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The class, origin, icon, reason, action and summary message are not kept.
    expect(JSON.stringify(result)).not.toMatch(/ENCOMIENDAS|encomiendas\.jpg|--|exito|El Salvador/);
    const kept = new Set(['local_time', 'location', 'description', 'provider_code', 'stage', 'stage_source']);
    expect(result.events!.flatMap((event) => Object.keys(event)).filter((key) => !kept.has(key))).toEqual([]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads an item between offices as in transit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Recibir envío en ubicación (entrada)', last_update_local: '2026-05-12T13:27:41', weight_kg: 0.4,
      events: [{ location: 'CENTRO DE EJEMPLO' }, { location: 'PUEBLO MUESTRA' }, { stage: 'accepted', local_time: '2026-05-11T16:58:44' }] });
    expect(result.events).toHaveLength(3);
  });

  it('reads mail from abroad under its origin code, without a destination, handed to the delivery agent twice', () => {
    const result = parseCorreosElSalvador(fixture('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2026-02-20T08:44:10',
      weight_kg: 0.12 });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Transferir envío al agente de entrega (entrada)', 'out_for_delivery'],
      ['Transferir envío al agente de entrega (entrada)', 'out_for_delivery'],
      ['Recibir envío en oficina de entrega (entrada)', 'in_transit'],
      ['Insertar envío en saca nacional', 'in_transit'],
      ['Enviar envío a ubicación nacional (entrada)', 'in_transit'],
      ['Recibir envío en oficina de cambio (entrada)', 'in_transit'],
    ]);
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('destination_country_name');
    expect(JSON.stringify(result)).not.toMatch(/China/);
    const abroad = parseCorreosElSalvador(edited('delivered', (payload) => { payload.envio.paisDestino = 'Guatemala'; }), DELIVERED);
    expect(abroad).toMatchObject({ destination_country: 'GT' });
    const unnamed = parseCorreosElSalvador(edited('delivered', (payload) => { payload.envio.paisDestino = 'Tierra de Muestra'; }), DELIVERED);
    expect(unnamed).toMatchObject({ destination_country_name: 'Tierra de Muestra' });
    expect(unnamed).not.toHaveProperty('destination_country');
  });

  it('turns an oldest-first history round, orders clocks by their fraction of a second, keeps a repeated scan once and keeps unknown wording', () => {
    const clocks = (result: { events?: { local_time?: unknown; description?: unknown }[] }) => result.events!.map((event) => [event.local_time, event.description]);
    const reversed = parseCorreosElSalvador(edited('delivered', (payload) => { payload.eventos.reverse(); }), DELIVERED);
    expect(clocks(reversed)).toEqual(clocks(parseCorreosElSalvador(fixture('delivered'), DELIVERED)));
    const fractions = parseCorreosElSalvador(edited('in-transit', (payload) => {
      payload.eventos = [{ ...payload.eventos[0]!, fecha: '2026-05-12T13:27:41.12', descripcion: 'Evento de muestra A' },
        { ...payload.eventos[0]!, fecha: '2026-05-12T13:27:41.5', descripcion: 'Evento de muestra B' }];
    }), IN_TRANSIT);
    expect(fractions.events!.map((event) => event.description)).toEqual(['Evento de muestra B', 'Evento de muestra A']);
    const repeated = parseCorreosElSalvador(edited('delivered', (payload) => { payload.eventos.splice(2, 0, { ...payload.eventos[2]! }); }), DELIVERED);
    expect(repeated.events).toHaveLength(7);
    const unknown = parseCorreosElSalvador(edited('in-transit', (payload) => {
      payload.eventos.unshift({ idEvento: 99, fecha: '2026-05-13T08:00:00', descripcion: 'Evento de muestra', oficina: null });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Evento de muestra',
      last_update_local: '2026-05-13T08:00:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-13T08:00:00', description: 'Evento de muestra', provider_code: '99' });
  });

  it('keeps scans of one clock in the reply’s order, whichever way it lists them', () => {
    const tied = (reversed: boolean) => parseCorreosElSalvador(edited('in-transit', (payload) => {
      const scan = (descripcion: string) => ({ ...payload.eventos[0]!, fecha: '2026-05-13T08:00:00', descripcion });
      payload.eventos.unshift(scan('Evento de muestra B'), scan('Evento de muestra A'));
      if (reversed) payload.eventos.reverse();
    }), IN_TRANSIT).events!.map((event) => event.description);
    expect(tied(true)).toEqual(tied(false));
  });

  it('takes the summary message’s stage only when no scan has one', () => {
    const unstaged = (message: unknown) => parseCorreosElSalvador(edited('in-transit', (payload) => {
      payload.eventos = [{ idEvento: 99, fecha: '2026-05-13T08:00:00', descripcion: 'Evento de muestra', oficina: 'CENTRO DE EJEMPLO' }];
      payload.mensajeAmigable = message;
    }), IN_TRANSIT);
    expect(unstaged('¡Paquete entregado con exito!')).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    const bare = unstaged('Mensaje de muestra');
    expect(bare).toMatchObject({ status: 'unknown', last_status_text: 'Evento de muestra' });
    expect(bare.current_stage).toBeUndefined();
    expect(parseCorreosElSalvador(edited('in-transit', (payload) => { payload.mensajeAmigable = '¡Paquete entregado con exito!'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads only the service’s own problem reply as not found, and any other 404 or 410 as a missing route', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(missing())).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(reply(NGINX, 404, 'text/html'))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(reply(text('not-found'), 404, 'application/json'))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply(text('not-found'), 410, 'application/problem+json'))).rejects.toMatchObject({ kind: 'transport', status: 410 });
    await expect(lookup(reply(text('not-found').replace('"Not Found"', '"Bad Request"'), 404, 'application/problem+json')))
      .rejects.toMatchObject({ kind: 'transport' });
    expect(isCorreosElSalvadorMissing('application/problem+json; charset=utf-8', text('not-found'))).toBe(true);
    expect(isCorreosElSalvadorMissing('application/problem+json', '{"title":"Not Found","status":"404"}')).toBe(false);
    expect(isCorreosElSalvadorMissing('application/problem+json', 'Not Found')).toBe(false);
    // A problem reply with HTTP 200 is no answer for the item.
    await expect(lookup(reply(text('not-found'), 200, 'application/problem+json'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('reads an empty reply or a reported failure as inconclusive and a firewall page as a challenge', async () => {
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(JSON.stringify({ envio: null, mensajeAmigable: null, eventos: null, message: 'Muestra', failed: true })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(JSON.stringify({ envio: null, mensajeAmigable: null, eventos: null, message: null, failed: false })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered').replaceAll(DELIVERED, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
    expect(() => parseCorreosElSalvador(edited('delivered', (payload) => { payload.eventos = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosElSalvador(edited('delivered', (payload) => { (payload as Record<string, unknown>).eventos = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseCorreosElSalvador(fixture('delivered'), 'RR900000036SV'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Correos de El Salvador answered for a different item' }));
    expect(() => parseCorreosElSalvador(fixture('inbound'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCorreosElSalvador(edited('delivered', (payload) => { payload.envio.numeroRastreo = ` ${DELIVERED.toLowerCase()} `; }), DELIVERED).events)
      .toHaveLength(7);
    for (const payload of [[], null, 'SUCCESS', { envio: [] }, { envio: { numeroRastreo: 7 } },
      edited('delivered', (reply) => { delete reply.envio.numeroRastreo; }),
      edited('delivered', (reply) => { reply.envio.peso = '1.25'; }),
      edited('delivered', (reply) => { reply.envio.peso = -1; }),
      edited('delivered', (reply) => { reply.envio.paisDestino = 7; }),
      edited('delivered', (reply) => { reply.mensajeAmigable = ['¡Paquete entregado con exito!']; }),
      edited('delivered', (reply) => { (reply as Record<string, unknown>).eventos = {}; }),
      edited('delivered', (reply) => { (reply.eventos as unknown[])[1] = 'scan'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.descripcion = ' '; }),
      edited('delivered', (reply) => { reply.eventos[1]!.descripcion = ['Entregar envío (entrada)']; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = '04/03/2026 08:31'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = '2026-03-04T08:31:14Z'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = '2026-03-04T08:31:14-06:00'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = '2026-02-30T08:31:14'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = '2026-03-04T24:00:00'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.fecha = null; }),
      edited('delivered', (reply) => { reply.eventos[1]!.oficina = 7; }),
      edited('delivered', (reply) => { reply.eventos[1]!.idEvento = 'A1'; }),
      edited('delivered', (reply) => { reply.eventos[1]!.idEvento = 1.5; }),
      edited('delivered', (reply) => { reply.eventos = Array.from({ length: 501 }, () => reply.eventos[0]!); })]) {
      expect(() => parseCorreosElSalvador(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CP900000010SV', 'CP90000001SV', 'CP900000019SVX', 'C9000000019SV', '1234567890123', 'SAMPLETRACKING', `CP${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCorreosElSalvadorNumber(' lx-900-000-040 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(missing());
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T11:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const route = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(carrier(route).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('',
      { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status, 'application/problem+json'));
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

  it('routes an item filed under Correos de El Salvador to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'correos-el-salvador' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'correos-el-salvador', source: 'correos-el-salvador', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(CORREOS_EL_SALVADOR_API))).toBe(true);
  });

  it('leaves Salvadoran S10 codes with the postal fallback, which does not ask it, and reads the former tracker’s links', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('correos-el-salvador');
    expect(parseTrackingInput(`https://www.correos.gob.sv/rastrear-paquete/${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'correos-el-salvador', source: 'link' });
  });
});

describe('Correos de El Salvador status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves the rest out on purpose', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (summaryStage(entry.wording)) {
        expect(summaryStage(entry.wording), entry.wording).toBe(entry.stage);
        continue;
      }
      const answer = statusMapAnswer({ carrier: 'correos-el-salvador', providerCode: entry.code, description: entry.wording });
      if (!entry.stage) {
        expect(correosElSalvadorEventStage(entry.wording), entry.wording).toBeUndefined();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(correosElSalvadorEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(correosElSalvadorStage('  ENTREGAR  envío (ENTRADA) ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(correosElSalvadorStage('Entregar envío')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(correosElSalvadorStage('Evento de muestra')).toBeNull();
    for (const wording of ['constructor', 'toString', 'Entregar envío (muestra)', 'Evento de muestra']) {
      expect(correosElSalvadorEventStage(wording), wording).toBeUndefined();
    }
    expect(summaryStage(' ¡PAQUETE ENTREGADO CON EXITO! ')).toBe('delivered');
    expect(summaryStage('Mensaje de muestra')).toBeUndefined();
  });
});
