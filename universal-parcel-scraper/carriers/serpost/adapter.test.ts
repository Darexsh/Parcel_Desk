import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SERPOST_LOOKUP, SERPOST_PAGE, SerpostTracker } from './adapter.js';
import { normalizeSerpostNumber, parseSerpost, parseSerpostForm } from './parser.js';
import { serpostEventStage, serpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014PE';
const IN_TRANSIT = 'ZZ000000028PE';
const UNKNOWN = 'ZZ000000045PE';
const INBOUND = 'ZZ000000014CN';
const TOKEN = 'CfDJ8SyntheticTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_bbbbbbbb-cccc';
const ANTIFORGERY = '.AspNetCore.Antiforgery.SyntheticKey';
type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const rows = (name: string): Row[] => JSON.parse(text(`${name}.json`)) as Row[];
const edited = (name: string, change: (rows: Row[]) => void): Row[] => {
  const reply = rows(name);
  change(reply);
  return reply;
};
const page = (cookies = [`${ANTIFORGERY}=syntheticCookie_1; path=/; samesite=strict; httponly`, 'cookiesession1=SYNTHETIC0000;Path=/'],
  body = text('page.html'), status = 200) =>
  new Response(body, { status, headers: [['Content-Type', 'text/html; charset=utf-8'], ...cookies.map(cookie => ['set-cookie', cookie] as [string, string])] });
const reply = (body: string, status = 200, type = 'text/plain; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
/** A transport that serves the page, then the lookup's reply. */
const site = (lookup: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (url) =>
  String(url) === SERPOST_PAGE ? page() : lookup());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const FIREWALL = '<html><head><title>Web Page Blocked</title></head><body>Attack ID: 20000000</body></html>';

describe('Serpost tracking adapter', () => {
  it('opens the tracking page and posts the whole code with its token and cookie, as the page does, through the supplied transport', async () => {
    const fetcher = site(() => reply(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SerpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 pe ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [lookupUrl, lookupInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(SERPOST_PAGE);
    expect(pageInit).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookupUrl).toBe(SERPOST_LOOKUP);
    expect(lookupInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', Cookie: `${ANTIFORGERY}=syntheticCookie_1`, 'X-CSRF-TOKEN': TOKEN } });
    expect(String(lookupInit.body)).toBe(`numeroTracking=${DELIVERED}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'serpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history on Lima time, with each office and its map, but not its address or WhatsApp number', () => {
    const result = parseSerpost(rows('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENVÍO ENTREGADO', last_update: '2026-03-12T15:41:09-05:00', delivered_at: '2026-03-12T15:41:09-05:00',
      expected_delivery: null, destination_country: 'PE' });
    // Newest first, and the repeated row is kept once.
    expect(result.events!.map(event => [event.time, event.location ?? null, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T15:41:09-05:00', null, 'ENVÍO ENTREGADO', '5', 'delivered'],
      ['2026-03-12T08:02:51-05:00', null, 'ENVÍO EN PROCESO DE DISTRIBUCIÓN', '9', 'out_for_delivery'],
      ['2026-03-12T07:40:13-05:00', 'ADMINISTRACION POSTAL VILLA MUESTRA', 'ENVÍO LLEGÓ A LA ADMINISTRACION POSTAL VILLA MUESTRA', '3', 'in_transit'],
      ['2026-03-11T18:20:44-05:00', null, 'ENVÍO EN PROCESAMIENTO DE DISTRIBUCIÓN EN EL DOMICILIO DE DESTINO', '2', 'in_transit'],
      ['2026-03-11T18:17:02-05:00', null, 'ENVÍO SIN OBSERVACIÓN POR LA ADUANA DEL PERÚ', '38', 'in_transit'],
      ['2026-02-27T10:15:00-05:00', 'ADMINISTRACION POSTAL PUEBLO EJEMPLO', 'ENVÍO ADMITIDO EN ADMINISTRACION POSTAL PUEBLO EJEMPLO', '012', 'accepted'],
    ]);
    expect(result.events![2]!.point).toEqual({ latitude: -12.0654, longitude: -77.0412 });
    expect(result.events!.filter(event => event.point)).toHaveLength(1);
    expect(result.events!.every(event => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Ejemplo N°|900000000|WHATSAPP|google|No disponible|Tu envío/);
  });

  it('reads an item being sorted for delivery as in transit', async () => {
    const result = await carrier(site(() => reply(text('in-transit.json')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-10-05T11:32:27-05:00',
      last_status_text: 'ENVÍO EN PROCESAMIENTO DE DISTRIBUCIÓN EN EL DOMICILIO DE DESTINO' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.at(-1)).toEqual({ time: '2026-10-02T16:48:00-05:00', location: 'OFICINA POSTAL EJEMPLO',
      description: 'ENVÍO ADMITIDO EN OFICINA POSTAL EJEMPLO', provider_code: '012', stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('reads mail from abroad, the older wordings and unknown ones, and keeps the scans in clock order', () => {
    const inbound = parseSerpost([
      { fecha: '01/20/2026 09:10:00', evento: 'SE INTENTO ENTREGAR PERO FUE IMPOSIBLE', codigo: '019', observacion: null },
      { fecha: '01/22/2026 10:00:00', evento: 'ENVÍO DISPONIBLE PARA ENTREGA O RECOJO.', codigo: '066' },
      { fecha: '01/15/2026 08:00:00', evento: 'ENVÍO SUJETO A TRÁMITE ANTE ADUANA. NO DISPONIBLE PARA ENTREGA.', codigo: '005', observacion: null },
      { fecha: '01/12/2026 23:30:00', evento: 'ENVÍO LLEGÓ A SERPOST. NO DISPONIBLE PARA ENTREGA.', codigo: '024', observacion: null },
    ], INBOUND);
    expect(inbound).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', destination_country: 'PE',
      last_update: '2026-01-22T10:00:00-05:00' });
    expect(inbound.events!.map(event => [event.stage, event.location ?? null])).toEqual([
      ['ready_for_pickup', null], ['failed_attempt', null], ['customs', null], ['in_transit', null]]);
    const unknown = parseSerpost(edited('in-transit', reply => { reply[0]!.evento = 'MUESTRA SIN SIGNIFICADO'; }), IN_TRANSIT);
    expect(unknown).toMatchObject({ last_status_text: 'MUESTRA SIN SIGNIFICADO', current_stage: 'in_transit' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    // A map outside Peru, or no map at all, is not the office's.
    const elsewhere = parseSerpost(edited('delivered', reply => {
      reply[2]!.observacion = String(reply[2]!.observacion).replace('!2d-77.0412345!3d-12.0654321', '!2d2.3522!3d48.8566');
    }), DELIVERED);
    expect(elsewhere.events!.some(event => event.point)).toBe(false);
    // An office written without an address keeps its whole name.
    const bare = parseSerpost(edited('delivered', reply => {
      reply[2]!.evento = 'ENVÍO LLEGÓ A LA OFICINA POSTAL MUESTRA  Y SI PREFIERES RECOGERLO EN ESTE LOCAL CONFÍRMANOS ESCRIBIENDO AL WHATSAPP .';
    }), DELIVERED);
    expect(bare.events![2]).toMatchObject({ location: 'OFICINA POSTAL MUESTRA', description: 'ENVÍO LLEGÓ A LA OFICINA POSTAL MUESTRA' });
  });

  it('reads the tracker’s empty answer as not found, and anything else short of a history as no answer', async () => {
    expect(() => parseSerpost(rows('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(site(() => reply(body, status, type))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found.json'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    // A refused token or session says nothing about the item.
    await expect(lookup('', 400)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('El número de tracking es requerido.', 400)).rejects.toMatchObject({ kind: 'indeterminate' });
    // A route the server does not know is not a missing item.
    await expect(lookup('<!doctype html><title>Not Found</title>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup('', 405)).rejects.toMatchObject({ kind: 'transport', status: 405 });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('in-transit.json')}`)).resolves.toMatchObject({ status: 'in_transit' });
  });

  it('keeps a bot check or firewall page, on the tracking page or in place of the reply, as a challenge', async () => {
    for (const body of [CHECK, FIREWALL]) {
      await expect(carrier(site(() => reply(body, 200, 'text/html'))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
      const blocked = vi.fn<typeof fetch>().mockImplementation(async () => page(undefined, body));
      await expect(carrier(blocked).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
      expect(blocked).toHaveBeenCalledTimes(1);
    }
    await expect(carrier(site(() => reply(CHECK, 403, 'text/html'))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => page(undefined, FIREWALL, 403));
    await expect(carrier(refused).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge', status: 403 });
  });

  it('needs the page’s form token and anti-forgery cookie before it asks', async () => {
    expect(parseSerpostForm(text('page.html'))).toBe(TOKEN);
    const changed = [text('page.html').replace(TOKEN, 'short'), text('page.html').replace('id="txtEnvio"', 'id="other"'),
      text('page.html').replace('__RequestVerificationToken', 'token'), '<html><body>Sample page</body></html>'];
    for (const html of changed) {
      expect(() => parseSerpostForm(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(undefined, html));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    for (const cookies of [[], ['cookiesession1=SYNTHETIC0000;Path=/'], [`${ANTIFORGERY}=has space; path=/`]]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(cookies));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const moved = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 302, headers: { Location: '/' } }));
    await expect(carrier(moved).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport', status: 302 });
  });

  it('rejects changed replies', () => {
    const changed: unknown[] = [null, 'reply', {}, { data: rows('in-transit') }, Array.from({ length: 201 }, () => rows('in-transit')[0]),
      edited('in-transit', reply => { reply[0] = 'row' as never; }),
      edited('in-transit', reply => { delete reply[0]!.evento; }),
      edited('in-transit', reply => { reply[0]!.evento = '  '; }),
      edited('in-transit', reply => { reply[0]!.evento = ['ENVÍO ENTREGADO']; }),
      edited('in-transit', reply => { reply[0]!.codigo = 5; }),
      edited('in-transit', reply => { reply[0]!.codigo = 'A5'; }),
      edited('in-transit', reply => { reply[0]!.observacion = { url: 'map' }; }),
      edited('in-transit', reply => { delete reply[0]!.fecha; }),
      edited('in-transit', reply => { reply[0]!.fecha = '2026-10-05T11:32:27'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '10/5/2026 11:32:27'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '10/05/2026 11:32'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '13/05/2026 11:32:27'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '02/30/2026 11:32:27'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '10/05/2026 24:32:27'; }),
      edited('in-transit', reply => { reply[0]!.fecha = '01/01/0001 00:00:00'; })];
    for (const payload of changed) {
      expect(() => parseSerpost(payload, IN_TRANSIT), JSON.stringify(payload)?.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the reply to the whole code: it takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The tracker answers for any code that starts with what it is sent, so a part of a code is never sent.
    for (const number of ['', 'ZZ000000015PE', 'ZZ00000001PE', 'ZZ000000014', 'ZZ000000014PEX', 'Z0000000014PE', '6100000000000',
      'ABC', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSerpostNumber(' zz-000-000-014 cn ')).toBe(INBOUND);
    expect(() => parseSerpost(rows('in-transit'), 'ZZ000000029PE')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const replies = [text('delivered.json'), text('not-found.json'), text('in-transit.json')];
    const fetcher = site(() => reply(replies.shift()!));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T20:41:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = site(() => new Response('Too many requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the lookup as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = site(() => reply(text('not-found.json'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it('tries once more in a new session after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async (url) => String(url) === SERPOST_PAGE ? page() : reply(text('delivered.json')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([SERPOST_PAGE, SERPOST_PAGE, SERPOST_LOOKUP]);
    const immediate = site(() => reply(text('delivered.json')));
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
    const large = site(() => new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Serpost to the adapter', async () => {
    const fetcher = site(() => reply(text('delivered.json')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'serpost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'serpost', source: 'serpost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SERPOST_PAGE, SERPOST_LOOKUP]);
  });
});

describe('Serpost status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, with or without its accents and office', () => {
    for (const entry of statuses.entries) {
      expect(serpostEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'serpost', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(serpostStage(' envio  ENTREGADO ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(serpostStage('ENVÍO ADMITIDO EN OFICINA POSTAL MUESTRA')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'MUESTRA', 'ENVÍO', '']) expect(serpostEventStage(wording), wording).toBeUndefined();
    expect(serpostStage('')).toBeNull();
    // The codes the page marks delivered or not delivered stand in for a wording the map does not know.
    expect(serpostStage('MUESTRA SIN SIGNIFICADO', '4')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(statusMap.stage('020', 'muestra')).toBe('delivered');
    expect(statusMap.stage('5', 'envio en procesamiento en sede central de serpost')).toBe('in_transit');
    for (const code of ['2', '005', 'constructor', null]) expect(statusMap.stage(code, 'muestra'), String(code)).toBeUndefined();
  });
});
