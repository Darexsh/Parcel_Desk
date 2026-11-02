import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ANDREANI_API, andreaniPayload, AndreaniTracker } from './adapter.js';
import { andreaniWording, normalizeAndreaniNumber, parseAndreani } from './parser.js';
import { andreaniLineStage, andreaniMilestoneStage, andreaniStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '360009000000010';
const IN_TRANSIT = '360009000000020';
const UNKNOWN = '360009000000090';

type Row = Record<string, unknown>;
type Milestone = Row & { traducciones: Row[] };
type Reply = Row & { procesoActual: Row; timelines: Milestone[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page Andreani's web firewall serves, with HTTP 500, for a request it blocks.
const BLOCKED = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head><title>The URL you requested has been blocked</title>'
  + '</head><body><div class="main"><h1>Web Page Blocked!</h1><p>Attack ID: 20000000</p></div></body></html>';
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const query = (url: string) => {
  const payload = new URL(url).searchParams.get('payload')!;
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from('12345678901234567890123456789012'), Buffer.from('1234567890123456'));
  return JSON.parse(Buffer.concat([decipher.update(payload, 'base64'), decipher.final()]).toString('utf8')) as unknown;
};

describe('Andreani HTTP adapter', () => {
  it('asks the tracking page’s lookup once for the whole number, sealed as the page seals it, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AndreaniTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 36000 9000-000020 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).startsWith(`${ANDREANI_API}?payload=`)).toBe(true);
    expect(query(String(url))).toEqual({ idReceptor: 1, idSistema: 1, userData: '{"mail":""}', numeroAndreani: IN_TRANSIT });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Authorization: expect.stringMatching(/^\w{64}$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'andreani', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // The same number seals to the same query; letters go in capitals.
    expect(andreaniPayload('G00000000000010')).toBe(andreaniPayload(normalizeAndreaniNumber('g0000 0000-000010')));
  });

  it('reads Argentina’s wall clocks as instants and each scan’s branch as the location, newest first', () => {
    const result = parseAndreani(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Ya entregamos tu envío. ¡Esperamos volver a verte pronto!', last_update: '2026-03-12T11:47:05-03:00',
      expected_delivery: null, delivered_at: '2026-03-12T11:47:05-03:00' });
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.stage])).toEqual([
      ['2026-03-12T11:47:05-03:00', 'Destino (calle 1)', 'delivered'],
      ['2026-03-12T08:31:10-03:00', 'Destino (calle 1)', 'out_for_delivery'],
      ['2026-03-12T06:54:48-03:00', 'Destino (calle 1)', 'in_transit'],
      ['2026-03-11T01:20:03-03:00', 'Centro Ejemplo Procesamiento', 'in_transit'],
      ['2026-03-09T19:44:51-03:00', 'Origen (av Ejemplo)', 'in_transit'],
      ['2026-03-09T15:02:40-03:00', 'Origen (av Ejemplo)', 'accepted'],
      // The parcel announced before intake names no branch.
      ['2026-03-09T09:15:22-03:00', null, 'registered'],
    ]);
    expect(result.events!.map((event) => event.description).slice(2, 6)).toEqual([
      'La sucursal Destino (calle 1) ya está procesando tu envío. ¡Pronto tendrás novedades!',
      'Tu envío se encuentra en camino a la sucursal Destino (calle 1).',
      'Tu envío salió de la sucursal Origen (av Ejemplo), en la localidad Ciudad Origen de la provincia Provincia Origen.',
      '¡Ya tenemos tu envío! El circuito comienza en Ciudad Origen, Provincia Origen. Pronto lo enviaremos a la sucursal encargada de la entrega.',
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.provider_code === undefined)).toBe(true);
    // The sender's account, the page's help texts and the delivery sentence are not kept.
    expect(JSON.stringify(result)).not.toMatch(/TIENDA|example\.com|30000000007|400000001|Pregunta|11:45hs|<|&nbsp;/);
  });

  it('reads a parcel out for delivery, and leaves a milestone still to come out', () => {
    const result = parseAndreani(fixture('in-transit'), IN_TRANSIT);
    expect(result).toEqual({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Hoy te visitaremos para entregarte tu envío.', last_update: '2026-04-21T08:05:39-03:00', expected_delivery: null,
      events: expect.any(Array) });
    expect(result.events!.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'in_transit', 'accepted']);
    // A milestone without lines, or with `null` for them, adds nothing.
    const empty = parseAndreani(changed('in-transit', (body) => { body.timelines[2]!.traducciones = null as never; }), IN_TRANSIT);
    expect(empty.events).toHaveLength(4);
  });

  it('reads an announced parcel as registered', () => {
    const result = parseAndreani(changed('delivered', (body) => {
      body.timelines = body.timelines.slice(0, 1);
      body.procesoActual.titulo = 'Pendiente de ingreso';
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Tu envío se encuentra pendiente de ingreso.' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('lets a milestone that ends the journey decide, and new wording fall to its milestone or the shared rules', () => {
    // A note logged after the delivery does not undo it.
    const after = parseAndreani(changed('delivered', (body) => {
      body.timelines[3]!.traducciones.unshift({ traduccion: 'Nota de ejemplo.', fechaEvento: '2026-03-12T12:10:00', sucursal: null });
    }), DELIVERED);
    expect(after).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Nota de ejemplo.', delivered_at: '2026-03-12T11:47:05-03:00' });
    expect(after.events![0]).toMatchObject({ stage: 'delivered', stage_source: 'carrier_map' });
    // New wording under a known milestone takes the milestone's stage.
    const known = parseAndreani(changed('in-transit', (body) => {
      body.timelines[1]!.traducciones[0]!.traduccion = 'Línea de ejemplo.';
    }), IN_TRANSIT);
    expect(known).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Línea de ejemplo.' });
    // Under a new milestone it falls to the shared rules, else has no stage.
    const worded = parseAndreani(changed('in-transit', (body) => {
      Object.assign(body.timelines[1]!, { titulo: 'Paso de ejemplo' });
      body.procesoActual.titulo = 'Paso de ejemplo';
      body.timelines[1]!.traducciones[0]!.traduccion = 'El envío fue entregado';
    }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseAndreani(changed('in-transit', (body) => {
      Object.assign(body.timelines[1]!, { titulo: 'Paso de ejemplo' });
      body.procesoActual.titulo = 'Paso de ejemplo';
      body.timelines[1]!.traducciones[0]!.traduccion = 'Línea de ejemplo.';
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Línea de ejemplo.' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('keeps a scan listed twice once, and the reply’s order at the same clock', () => {
    const result = parseAndreani(changed('in-transit', (body) => {
      body.timelines[1]!.traducciones.push(structuredClone(body.timelines[1]!.traducciones[0]!));
    }), IN_TRANSIT);
    expect(result.events).toHaveLength(4);
  });

  it('turns the page’s HTML into text and drops phone and identity-card numbers', () => {
    expect(andreaniWording('Ya entregamos tu envío.<br>¡Esperamos volver a verte pronto!'))
      .toBe('Ya entregamos tu envío. ¡Esperamos volver a verte pronto!');
    expect(andreaniWording('<p>Llamanos al <b>+54 11 5555-0000</b> o mostrá tu DNI 30.000.000 &amp; listo.</p>'))
      .toBe('Llamanos al o mostrá tu DNI & listo.');
    expect(andreaniWording('<p> </p>')).toBe('');
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parseAndreani(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Andreani answered for another shipment' }));
    expect(parseAndreani(changed('in-transit', (body) => { body.numeroAndreani = ` ${IN_TRANSIT} `; }), IN_TRANSIT).events).toHaveLength(4);
  });

  it('reads the service’s reply without a shipment as not found, and a shipment without scans as no history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('null\n', 206));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(() => parseAndreani(JSON.parse(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAndreani(changed('in-transit', (body) => { body.timelines = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.numeroAndreani; },
      (body: Reply) => { body.numeroAndreani = 360009000000020; },
      (body: Reply) => { body.timelines = 'milestones' as never; },
      (body: Reply) => { body.timelines = Array.from({ length: 31 }, () => body.timelines[0]!); },
      (body: Reply) => { body.timelines[1]!.traducciones = Array.from({ length: 301 }, () => body.timelines[1]!.traducciones[0]!); },
      (body: Reply) => { body.timelines[0] = 'milestone' as never; },
      (body: Reply) => { delete body.timelines[0]!.titulo; },
      (body: Reply) => { body.timelines[0]!.titulo = ' '; },
      (body: Reply) => { body.timelines[0]!.traducciones = 'scans' as never; },
      (body: Reply) => { body.timelines[0]!.traducciones[0] = 'scan' as never; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.traduccion = 7; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.sucursal = 'Origen'; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.sucursal = { nombre: 7 }; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.fechaEvento = null; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.fechaEvento = '20/04/2026 10:12'; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.fechaEvento = '2026-04-20T10:12:08Z'; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.fechaEvento = '2026-02-30T10:00:00'; },
      (body: Reply) => { body.timelines[0]!.traducciones[0]!.fechaEvento = '2026-04-20T24:00:00'; },
      (body: Reply) => { body.procesoActual = 'En camino' as never; },
    ]) {
      expect(() => parseAndreani(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [[], 'null', 7, 'Envío']) expect(() => parseAndreani(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a block page, a moved service and a broken reply apart from missing parcels', async () => {
    const lookup = (body: string, status = 200, headers: Record<string, string> = {}) =>
      carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, headers))).track({ number: UNKNOWN });
    await expect(lookup(BLOCKED, 500, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge', status: 500 });
    await expect(lookup(BLOCKED, 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Andreani</title></html>', 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 200)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 206)).rejects.toMatchObject({ kind: 'schema' });
    // The service's own failure, as for a payload it cannot read.
    await expect(lookup('[{"Code":"500 internal server","Property":"System.FormatException","Message":"Sample"}]', 500))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(lookup('', 301, { Location: 'https://www.andreani.com/' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', 404)).rejects.toMatchObject({ kind: 'transport' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[400, 'transport'], [401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply([{ code: '', property: '', message: 'Sample' }], status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number, and asks nothing for one Andreani does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T14:47:05.000Z' });
    await expect(carrier(fetcher).recognize!('36-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers Andreani does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['36000', 'SAMPLETRACKING', `3${'0'.repeat(40)}`, '360009000000010/1']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAndreaniNumber(' u 7000-0001 ')).toBe('U70000001');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Andreani to the adapter, and leaves its plain digit run unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'andreani' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'andreani', source: 'andreani', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${ANDREANI_API}?payload=`))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('andreani');
  });
});

describe('Andreani status vocabulary', () => {
  it('records every line and milestone seen live with the stage the map gives it', () => {
    const entries = (statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[])
      .filter((entry) => entry.confirmedBy === 'live');
    const lines = entries.filter((entry) => andreaniLineStage(entry.wording));
    expect(lines).toHaveLength(7);
    for (const entry of entries) {
      expect(andreaniLineStage(entry.wording) ?? andreaniMilestoneStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'andreani', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A milestone stages a line the map does not know.
    for (const entry of entries.filter((item) => !lines.includes(item))) {
      expect(andreaniStage(entry.wording, 'Línea de ejemplo.'), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'andreani', providerCode: null, description: 'Línea de ejemplo.' })).toEqual({ kind: 'unknown' });
  });
});
