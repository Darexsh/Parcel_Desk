import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, COPA_COURIER_HOME, COPA_COURIER_LOOKUP, CopaCourierTracker } from './adapter.js';
import { normalizeCopaCourierNumber, parseCopaCourier, parseCopaCourierForm } from './parser.js';
import { copaCourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'H9000001';
const IN_TRANSIT = 'H9000002';
const UNKNOWN = 'H0000000';
const TOKEN = 'CfDJ8SYNTHETICTRACKINGFORMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbb-cccc';
const ANTIFORGERY = '.AspNetCore.Antiforgery.Synthetic01';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const changed = (name: string, from: string | RegExp, to: string) => edited(fixture(name), from, to);
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const home = (cookies = [`${ANTIFORGERY}=syntheticCookie_1; path=/; samesite=strict; httponly`]) => new Response(fixture('form'),
  { headers: [['Content-Type', 'text/html; charset=utf-8'], ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
/** A transport that serves the home page, then `reply` for the post. */
const site = (reply: (body: string) => Response) => vi.fn<typeof fetch>().mockImplementation(async (url, init) =>
  (String(url) === COPA_COURIER_HOME ? home() : reply(String(init?.body))));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (html: string, number: string) => parseCopaCourier(html, number).events!
  .map((event) => [event.local_time, event.location ?? null, event.stage ?? null, event.description]);
const notice = (text: string) => edited(fixture('not-found'), 'Lo sentimos pero no hemos encontrado el código en nuestra base de datos.', text);

describe('Copa Courier HTTP adapter', () => {
  it('opens a session on the home page and posts the whole HAWB with its token, through the supplied transport', async () => {
    const fetcher = site(() => page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CopaCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' h900-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[homeUrl, homeInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(homeUrl).toBe('https://www.copacourier.com/');
    expect(homeInit).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(homeInit.headers).has('Cookie')).toBe(false);
    expect(url).toBe(COPA_COURIER_LOOKUP);
    expect(url).toBe('https://www.copacourier.com/Hawb/Hawb');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      body: `txtNumeroHAWB=${IN_TRANSIT}&__RequestVerificationToken=${TOKEN}` });
    expect(init.headers).toMatchObject({ Accept: 'text/html', 'Accept-Language': 'es', 'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SyntheticHost/1.0', Cookie: `${ANTIFORGERY}=syntheticCookie_1`, Referer: COPA_COURIER_HOME });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'copa-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, with the van before the delivery it brought at the same minute', () => {
    const result = parseCopaCourier(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENVÍO ENTREGADO', last_update: null, last_update_local: '2026-02-17T11:35:00', expected_delivery: null, weight_kg: 2.5 });
    expect(timeline(fixture('delivered'), DELIVERED)).toEqual([
      ['2026-02-17T11:35:00', 'Havana, Cuba', 'delivered', 'ENVÍO ENTREGADO'],
      ['2026-02-17T11:35:00', 'Havana, Cuba', 'delivered', 'CONFIRMACIÓN DE ENTREGA'],
      // The page lists the van last, at the delivery's minute.
      ['2026-02-17T11:35:00', 'Havana, Cuba', 'out_for_delivery', 'EN VEHÍCULO DE COPA COURIER PARA SU ENTREGA'],
      ['2026-02-10T13:20:00', null, 'in_transit', 'LIBERADO POR ADUANA'],
      ['2026-02-10T13:18:00', null, 'customs', 'EN PROCESO DE ADUANA'],
      ['2026-02-10T13:15:00', null, 'in_transit', 'LLEGO AL CENTRO DE DISTRIBUCION'],
      ['2026-02-10T13:13:00', null, 'in_transit', 'ARRIBO A ESTACION'],
      ['2026-02-10T13:12:00', 'Havana, Cuba', 'in_transit', 'RECIBIDO EN DESTINO'],
      // A row repeated whole is kept once.
      ['2026-02-04T09:30:00', 'Panama City, Panama', 'in_transit', 'PARTIENDO DE ORIGEN O PUNTO DE TRÁNSITO'],
      ['2026-02-04T08:05:00', 'Panama City, Panama', 'in_transit', 'RECIBIDO EN PUNTO DE TRÁNSITO'],
      ['2026-02-03T16:40:00', 'San José, Costa Rica', 'in_transit', 'PARTIENDO DE ORIGEN O PUNTO DE TRÁNSITO'],
      ['2026-02-03T10:15:00', 'San José, Costa Rica', 'accepted', 'ENVIO RECIBIDO EN ORIGEN'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps no recipient, identity card, towns or package count', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseCopaCourier(fixture(name), number));
      expect(text, name).not.toMatch(/SAMPLE RECIPIENT|Entregado a|00000000000|No\. Serie|SAMPLE (?:CITY|TOWN)|Sample (?:Free Zone|Province)|bultos/i);
    }
  });

  it('reads a parcel that stopped at customs, and a station the map does not name by its code', () => {
    expect(parseCopaCourier(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'customs',
      last_status_text: 'EN PROCESO DE ADUANA', last_update_local: '2026-09-01T12:13:00', weight_kg: 1.5 });
    expect(timeline(fixture('in-transit'), IN_TRANSIT).slice(-3)).toEqual([
      ['2026-08-20T22:07:00', 'Panama City, Panama', 'in_transit', 'RECIBIDO EN PUNTO DE TRÁNSITO'],
      ['2026-08-20T18:03:00', 'Colón, Panama', 'in_transit', 'PARTIENDO DE ORIGEN O PUNTO DE TRÁNSITO'],
      ['2026-08-20T15:44:00', 'Colón, Panama', 'accepted', 'ENVIO RECIBIDO EN ORIGEN'],
    ]);
    const elsewhere = changed('in-transit', 'ENVIO RECIBIDO EN ORIGEN - ONX', 'ENVIO RECIBIDO EN ORIGEN - XYZ');
    expect(timeline(elsewhere, IN_TRANSIT).at(-1)).toEqual(['2026-08-20T15:44:00', 'XYZ', 'accepted', 'ENVIO RECIBIDO EN ORIGEN']);
    // Wording without a station keeps all its words.
    const bare = changed('in-transit', 'EN PROCESO DE ADUANA - ', 'EN PROCESO DE ADUANA');
    expect(timeline(bare, IN_TRANSIT)[0]).toEqual(['2026-09-01T12:13:00', null, 'customs', 'EN PROCESO DE ADUANA']);
    // A weight the page does not label in kilograms, or does not write as one, is not kept.
    expect(parseCopaCourier(changed('in-transit', 'Peso (Kg)', 'Peso (Lb)'), IN_TRANSIT)).not.toHaveProperty('weight_kg');
    expect(parseCopaCourier(changed('in-transit', '>1,5<', '>0<'), IN_TRANSIT)).not.toHaveProperty('weight_kg');
  });

  it('reads a hand-off for a remote area as in transit, and wording the map does not know without a stage', () => {
    const remote = changed('in-transit', /(fechadetalle'>)01-sept\.-2026 12:13(<\/label>\s*<label class='etiq hitodescripcion'>)EN PROCESO DE ADUANA - /,
      '$102-sept.-2026 09:00$2ENTREGA EN AREA REMOTA - ');
    expect(parseCopaCourier(remote, IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'ENTREGA EN AREA REMOTA' });
    const strange = changed('in-transit', 'EN PROCESO DE ADUANA - ', 'SAMPLE MILESTONE - ');
    expect(parseCopaCourier(strange, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'SAMPLE MILESTONE' });
    expect(parseCopaCourier(strange, IN_TRANSIT).events![0]).not.toHaveProperty('stage');
  });

  it('reads Spanish and English month names and refuses a clock that is not one', () => {
    for (const [written, local] of [['22-dic.-2026 15:08', '2026-12-22T15:08:00'], ['05-ene.-2027 00:00', '2027-01-05T00:00:00'],
      ['9-may.-2026 09:30', '2026-05-09T09:30:00'], ['01-Sep-2026 12:13', '2026-09-01T12:13:00'], ['01-Dec-2026 23:59', '2026-12-01T23:59:00']] as const) {
      expect(parseCopaCourier(changed('in-transit', '01-sept.-2026 12:13', written), IN_TRANSIT).events!.find((event) =>
        event.description === 'EN PROCESO DE ADUANA')?.local_time, written).toBe(local);
    }
    for (const written of ['31-feb.-2026 10:00', '01-xyz.-2026 10:00', '01-sept.-2026 24:00', '01-sept.-2026', '2026-09-01 12:13', '']) {
      expect(() => parseCopaCourier(changed('in-transit', '01-sept.-2026 12:13', written), IN_TRANSIT), written)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it("reads the tracker's notice for an unknown HAWB as not found, and its format refusal as a changed request", () => {
    expect(() => parseCopaCourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCopaCourier(notice('Se ha introducido un Hawb en formato incorrecto.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCopaCourier(notice(''), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a shipment only when the page names the HAWB asked', () => {
    expect(() => parseCopaCourier(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Copa Courier answered for a different HAWB' }));
    expect(() => parseCopaCourier(changed('in-transit', `>${IN_TRANSIT}<`, `>${IN_TRANSIT}0<`), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Copa Courier answered for a different HAWB' }));
  });

  it('reads a shipment without milestones as no history', () => {
    const empty = changed('in-transit', /<li class='detallelista'>[\s\S]*<\/li>(\s*<\/ul>)/, '$1');
    expect(() => parseCopaCourier(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const box = fixture('in-transit').match(/<div runat="server" class="cajaseguimiento"[\s\S]*<\/ul>\s*<\/div>\s*<\/div>/)![0];
    for (const [index, html] of [
      '<html><title>Copa Courier</title></html>',
      changed('in-transit', 'id="bodySeguimiento"', 'id="body"'),
      changed('in-transit', 'ID="lblHAWB1"', 'ID="lblGuia1"'),
      changed('in-transit', 'id="bmilistadetalle1"', 'id="bmilista1"'),
      changed('in-transit', "class='etiq fechadetalle'>20-ago.-2026 15:44", "class='etiq fecha'>20-ago.-2026 15:44"),
      changed('in-transit', "class='etiq hitodescripcion'>ENVIO RECIBIDO EN ORIGEN - ONX", "class='etiq hito'>ENVIO RECIBIDO EN ORIGEN - ONX"),
      changed('in-transit', 'ENVIO RECIBIDO EN ORIGEN - ONX', ' - ONX'),
      changed('in-transit', box, box + box),
    ].entries()) {
      expect(() => parseCopaCourier(html, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const row = fixture('in-transit').match(/<li class='detallelista'>[\s\S]*?<\/li>/)![0];
    expect(() => parseCopaCourier(changed('in-transit', row, row.repeat(501)), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the tracking form token and refuses a changed form', () => {
    expect(parseCopaCourierForm(fixture('form'))).toBe(TOKEN);
    expect(() => parseCopaCourierForm(changed('form', 'action="/Hawb/Hawb"', 'action="/Hawb/Buscar"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCopaCourierForm(changed('form', 'name="txtNumeroHAWB"', 'name="hawb"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCopaCourierForm(changed('form', TOKEN, ''))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCopaCourierForm('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps an unknown HAWB, a refused token, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (reply: Response) => carrier(site(() => reply)).track({ number: UNKNOWN });
    await expect(lookup(page(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('', { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(page(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('', { status: 302, headers: { Location: '/Home/Error' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><head><title>Access Denied</title></head><body>Request blocked.</body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(page('<html><title>Copa Courier</title><body>En mantenimiento</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('needs the anti-forgery cookie, and reads a blocked or moved home page without posting', async () => {
    const cookieless = vi.fn<typeof fetch>().mockImplementation(async () => home(['other=1; path=/']));
    await expect(carrier(cookieless).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(cookieless).toHaveBeenCalledTimes(1);
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(page('<html><head><title>Access Denied</title></head></html>', { status: 200 }));
    await expect(carrier(blocked).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValue(page('', { status: 301, headers: { Location: 'https://example.com/' } }));
    await expect(carrier(moved).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('rejects numbers Copa Courier does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['H900000', 'H90000011', '9000001', 'A9000001', 'HH900000', 'H'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCopaCourierNumber(' h 9000002 ')).toBe(IN_TRANSIT);
  });

  it('recognizes a known HAWB and the unknown-HAWB answer, and asks nothing for a number Copa Courier does not issue', async () => {
    const fetcher = site((body) => page(fixture(body.startsWith(`txtNumeroHAWB=${DELIVERED}&`) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-17T11:35:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('H90000011')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(carrier(site(() => page('', { status: 429 }))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('tries once more in a new session after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => home()).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => home()).mockImplementationOnce(async () => page(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([COPA_COURIER_HOME, COPA_COURIER_LOOKUP, COPA_COURIER_HOME, COPA_COURIER_LOOKUP]);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a HAWB filed under Copa Courier to the adapter', async () => {
    const fetcher = site(() => page(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'copa-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'copa-courier', source: 'copa-courier', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === COPA_COURIER_LOOKUP
      && String(init?.body).startsWith(`txtNumeroHAWB=${DELIVERED}&`))).toBe(true);
  });

  it('suggests Copa Courier for an H and seven digits, with low confidence beside the eight-character rules', () => {
    const match = detectCarrierMatch(DELIVERED);
    expect(match.candidates).toContain('copa-courier');
    expect(match.confidence).toBe('low');
  });
});

describe('Copa Courier status vocabulary', () => {
  it('records every wording the tracker shows with the stage the map gives it', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(copaCourierStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // The tracker writes accents on some milestones and not others.
    expect(statusMap.stage(null, 'envío recibido en origen')).toBe('accepted');
    expect(statusMap.stage(null, 'envio entregado')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'copa-courier', description: 'ENVÍO ENTREGADO' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'copa-courier', description: 'Sample Milestone' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('X1', 'envio entregado')).toBeUndefined();
  });
});
