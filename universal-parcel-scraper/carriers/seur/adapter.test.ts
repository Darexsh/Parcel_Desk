import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { SeurTracker, adapter } from './adapter.js';
import { accepted } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeSeurNumber, normalizeSeurRecognitionNumber, parseSeur } from './parser.js';
import { classifySeurStatus, seurStatusGroup } from './status.js';
import fixture from './fixtures/history.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError } from '../../core/errors/index.js';
import { universalCarrierHints } from '../../providers/shared/hints.js';

const NUMBER = '9900002';
const copy = () => structuredClone(fixture);
const response = (body: unknown = fixture) => Response.json(body);
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });
const noHistory = { codigo_error: 'ERR_CNSPLI_002', identificador_busqueda: null, clave_envio: null, situaciones: null };

describe('SEUR simplified anonymous tracking', () => {
  it('projects observed scan semantics, Spanish wall clocks and explicitly labelled kilogram weight', () => {
    const result = normalizeCarrierResult(parseSeur(fixture, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-01-23T13:13:05', weight_kg: 1.2 });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toHaveLength(6);
    expect(result.events?.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'LL020', provider_status: 'EL ENVÍO HA SIDO ENTREGADO A UN VECINO.', local_time: '2026-01-23T13:13:05' });
    expect(result.events?.every(e => e.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    expect(result.events?.every(e => !e.location)).toBe(true);
    for (const entry of statuses.entries) {
      expect(classifySeurStatus(entry.code, seurStatusGroup(entry.code)!, entry.wording)?.stage).toBe(entry.stage);
    }
  });

  it('keeps the stage a parcel had through each delay notice', () => {
    for (const code of ['LI300', 'LI582', 'LI557', 'LI587']) {
      const body = copy();
      const delay = { fecha: '2026-01-24T10:00:00Z', cod_situacion: code, grupo_situacion: 'EN DEMORA',
        descripcion_situacion: statuses.entries.find(entry => entry.code === code)!.wording };
      body.situaciones = [delay, ...body.situaciones.slice(3)] as typeof body.situaciones;
      const result = parseSeur(body, NUMBER);
      expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-01-24T10:00:00' });
      expect(result.events?.[0]).toMatchObject({ provider_code: code, stage: 'in_transit', stage_source: 'none' });
      // A delay that is all SEUR lists is a shipment on its way.
      body.situaciones = [delay] as typeof body.situaciones;
      expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
      expect(parseSeur(body, NUMBER).events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    }
  });

  it('reads a parcel pending arrival at its destination as in transit', () => {
    const body = copy();
    body.situaciones = [{ fecha: '2026-01-24T10:00:00Z', cod_situacion: 'LI511', grupo_situacion: 'EN DEMORA',
      descripcion_situacion: statuses.entries.find(entry => entry.code === 'LI511')!.wording }, ...body.situaciones.slice(4)] as typeof body.situaciones;
    expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('stages pickup points, failed attempts, agreed days and customs', () => {
    const scan = (code: string, fecha: string) => ({ fecha, cod_situacion: code, grupo_situacion: seurStatusGroup(code)!,
      descripcion_situacion: statuses.entries.find(entry => entry.code === code)!.wording });
    const body = copy();
    body.situaciones = [scan('LI530', '2026-01-24T10:00:00Z'), scan('LJ105', '2026-01-23T18:00:00Z'), scan('LI523', '2026-01-23T12:00:00Z'),
      scan('LJ100', '2026-01-22T18:00:00Z'), scan('LD223', '2026-01-22T09:00:00Z'), scan('LD221', '2026-01-21T09:00:00Z')] as typeof body.situaciones;
    const result = parseSeur(body, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', last_update_local: '2026-01-24T10:00:00' });
    expect(result.events?.map(e => e.stage)).toEqual(['ready_for_pickup', 'in_transit', 'failed_attempt', 'in_transit', 'in_transit', 'customs']);
    body.situaciones.unshift(scan('LL010', '2026-01-25T11:00:00Z') as never);
    expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
  });

  it('reads the pickup SEUR makes on a pickup reference as the parcel accepted', () => {
    const scan = (code: string, fecha: string) => ({ fecha, cod_situacion: code, grupo_situacion: seurStatusGroup(code)!,
      descripcion_situacion: statuses.entries.find(entry => entry.code === code)!.wording });
    const body = copy();
    body.situaciones = [scan('SX001', '2026-01-21T21:46:02Z'), scan('SX605', '2026-01-21T12:47:02Z')] as typeof body.situaciones;
    const result = parseSeur(body, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(result.events?.map(e => e.stage)).toEqual(['accepted', 'accepted']);
  });

  it('reads a delivery held by customs for its invoice through the codes SEUR scans it with', () => {
    const scan = (code: string, fecha: string) => ({ fecha, cod_situacion: code, grupo_situacion: seurStatusGroup(code)!,
      descripcion_situacion: statuses.entries.find(entry => entry.code === code)!.wording });
    const body = copy();
    body.situaciones = [scan('LL001', '2026-01-24T18:15:00Z'), scan('LC001', '2026-01-24T15:54:00Z'), scan('LI580', '2026-01-24T12:54:08Z'),
      scan('LI717', '2026-01-24T10:42:56Z'), scan('LT859', '2026-01-22T23:08:15Z'), scan('SC999', '2026-01-22T23:05:10Z')] as typeof body.situaciones;
    const result = parseSeur(body, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(result.events?.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'customs', 'exception', 'in_transit', 'registered']);
    body.situaciones = body.situaciones.slice(3);
    expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
  });

  it('reads an incomplete or wrong address after the delivery round as a failed attempt', () => {
    const scan = (code: string, fecha: string) => ({ fecha, cod_situacion: code, grupo_situacion: seurStatusGroup(code)!,
      descripcion_situacion: statuses.entries.find(entry => entry.code === code)!.wording });
    const body = copy();
    body.situaciones = [scan('LI521', '2026-01-23T15:00:00Z'), scan('LC003', '2026-01-23T08:00:00Z')] as typeof body.situaciones;
    expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(parseSeur(body, NUMBER).events?.map(e => e.stage)).toEqual(['failed_attempt', 'out_for_delivery']);
  });

  it('requires exact identity, nonempty single-piece history and the supported numeric shapes', () => {
    for (const n of ['9900002', '990000000002', '99000000000002', '990000000000000000002', '9900000000000000000002']) expect(normalizeSeurNumber(n)).toBe(n);
    expect(normalizeSeurNumber('990 0002')).toBe(NUMBER);
    // A pickup's reference, which a provider can name SEUR for.
    expect(normalizeSeurNumber('rec990000000001')).toBe('REC990000000001');
    for (const n of ['', '123', '99000002', 'AA9900002', 'REC99000000001', 'RE990000000001', NUMBER + '?', NUMBER + '/']) expect(() => normalizeSeurNumber(n)).toThrow(InvalidInputError);
    for (const bad of [{ ...fixture, identificador_busqueda: '9900003' }, { ...fixture, identificador_busqueda: fixture.clave_envio },
      { ...fixture, clave_envio: '' }, { ...fixture, clave_envio: null }, { ...fixture, situaciones: {} }, {}, null, [fixture]]) {
      expect(() => parseSeur(bad, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const pieces of [undefined, null, 0, 2, '1']) expect(() => parseSeur({ ...fixture, num_bultos: pieces }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const pieces of [{}, [null], [{ peso: 1 }, { peso: 2 }]]) expect(() => parseSeur({ ...fixture, bultos: pieces }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const pieces of [null, [], [{ peso: 1.2 }]]) expect(parseSeur({ ...fixture, bultos: pieces }, NUMBER).status).toBe('delivered');
    expect(() => parseSeur({ ...fixture, situaciones: [] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it("finds a shipment by its sender's twenty-two-digit reference, which the lookup names as searched", async () => {
    // Synthetic: a sender's reference dated 15 October 2026, day before month, and SEUR's own number.
    const reference = '2026151000000000000001';
    const body = { ...copy(), identificador_busqueda: reference, clave_envio: '990000000000000000002' };
    expect(parseSeur(body, reference).status).toBe('delivered');
    expect(await adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(response(body)))).recognize!(reference))
      .toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-23T13:13:05' });
    expect(() => parseSeur({ ...body, identificador_busqueda: body.clave_envio }, reference)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('confirms twelve digits a provider names SEUR for, which recognition never asks it about', async () => {
    // Synthetic: twelve digits fit many carriers' rules, none of them SEUR's.
    const number = '990000000002';
    expect(universalCarrierHints(['Seur'], number).discovered_carrier).toBe('seur');
    expect(detectCarrierMatch(number).candidates).not.toContain('seur');
    expect(recognitionCandidates(number, { countryHint: 'ES' }).map(({ carrier }) => carrier)).not.toContain('seur');
    const body = { ...copy(), identificador_busqueda: number };
    const result = await adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(response(body)))).track({ number });
    expect(result.status).toBe('delivered');
  });

  it('keeps absent, recent and out-of-range lookup errors inconclusive', () => {
    for (const body of [noHistory, { ...noHistory, codigo_error: 'NEW_ERROR' }, { ...fixture, codigo_error: 'ERR_CNSPLI_002' }, { ...noHistory, codigo_error: '' }]) {
      expect(() => parseSeur(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
      expect(() => parseSeur(body, NUMBER)).not.toThrowError(expect.objectContaining({ kind: 'not_found' }));
    }
  });

  it('names only the known lookup error as a number the portal does not know', () => {
    expect(() => parseSeur(noHistory, NUMBER)).toThrowError(expect.objectContaining({ reason: 'portal_not_found' }));
    for (const body of [{ ...noHistory, codigo_error: 'NEW_ERROR' }, { ...fixture, codigo_error: 'ERR_CNSPLI_002' }, { ...noHistory, codigo_error: '' }]) {
      expect(() => parseSeur(body, NUMBER)).not.toThrowError(expect.objectContaining({ reason: 'portal_not_found' }));
    }
  });

  it('does not infer completed delivery from planned wording, changed groups or arbitrary codes', () => {
    for (const change of [{ cod_situacion: 'ZZ999' }, { descripcion_situacion: 'EL ENVÍO SERÁ ENTREGADO MAÑANA.' },
      { grupo_situacion: 'ENTREGA PREVISTA' }, { descripcion_situacion: 'EL ENVÍO NO HA SIDO ENTREGADO.' }]) {
      const body = copy(); Object.assign(body.situaciones[0]!, change);
      expect(parseSeur(body, NUMBER)).toMatchObject({ status: 'unknown' });
      expect(parseSeur(body, NUMBER).current_stage).toBeUndefined();
      expect(parseSeur(body, NUMBER).delivered_at).toBeUndefined();
    }
    for (const code of ['constructor', 'toString', 'ZZ999']) expect(classifySeurStatus(code, 'ENTREGADO', fixture.situaciones[0]!.descripcion_situacion)).toBeUndefined();
  });

  it('retains the newest unresolved clock and never borrows older delivery or freshness', () => {
    for (const date of ['', '2026-01-23', '2026-02-30T13:00:00Z', '2026-01-23T25:00:00Z', '2026-01-23T13:00:00+24:00', '2026-01-23T13:00:00+01:60', 'future morning']) {
      const body = copy(); body.situaciones[0]!.fecha = date; body.situaciones[1] = { ...body.situaciones[0]!, fecha: '2026-01-22T13:00:00+01:00' };
      const result = parseSeur(body, NUMBER);
      expect(result.status).toBe('delivered'); expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.time).toBeUndefined(); expect(result.events?.[0]!.provider_time_text).toBe(date || undefined);
      expect(result.events?.[1]!.time).toBe('2026-01-22T13:00:00+01:00');
    }
    const marked = copy(); marked.situaciones[0]!.fecha = '2026-07-23T13:13:05.120Z';
    expect(parseSeur(marked, NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-07-23T13:13:05.120' });
    const naive = copy(); naive.situaciones[0]!.fecha = '2026-01-23T13:13:05';
    expect(parseSeur(naive, NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-01-23T13:13:05' });
    expect(parseSeur(naive, NUMBER).delivered_at).toBeUndefined();
    const offset = copy(); offset.situaciones[0]!.fecha = '2026-01-23T13:13:05+01:00';
    expect(parseSeur(offset, NUMBER)).toMatchObject({ last_update: '2026-01-23T13:13:05+01:00', delivered_at: '2026-01-23T13:13:05+01:00' });
  });

  it('preserves source position for repeated scans and validates the whole bounded feed', () => {
    const body = copy(); body.situaciones.splice(1, 0, { ...body.situaciones[1]!, fecha: body.situaciones[0]!.fecha }, { ...body.situaciones[0]! });
    expect(parseSeur(body, NUMBER).events?.slice(0, 3).map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'delivered']);
    for (const change of [{ cod_situacion: '' }, { grupo_situacion: '' }, { descripcion_situacion: '' }, { descripcion_situacion: 'X'.repeat(501) }, { fecha: 'X'.repeat(65) }]) {
      const bad = copy(); Object.assign(bad.situaciones[0]!, change);
      expect(() => parseSeur(bad, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSeur({ ...fixture, situaciones: [...fixture.situaciones, null] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSeur({ ...fixture, situaciones: Array(501).fill(fixture.situaciones[0]) }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseSeur({ ...fixture, situaciones: Array(110).fill(fixture.situaciones[0]) }, NUMBER).events).toHaveLength(100);
  });

  it('omits unsupported, zero or invalid weights without losing tracking', () => {
    for (const weight of [undefined, null, -1, 0, NaN, Infinity, 100001, '1.2', '1 lb']) expect(parseSeur({ ...fixture, peso: weight }, NUMBER).weight_kg).toBeUndefined();
  });

  it('uses the exact official simplified POST through the full factory without recipient credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://www.seur.com/miseur/backend/consultarEnvioLTSimple');
      expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'manual' });
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(new Headers(init?.headers).has('cookie')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ telefono: null, email: null, identificador_busqueda: NUMBER,
        idioma: 'es', cod_postal: '', tipo_actor: 'DST', cipher: false, origen_mkt: false });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return response();
    });
    expect(await adapter(environment(fetcher)).track({ number: NUMBER, postcode: 'PRIVATE_SYNTHETIC' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes matching activity, skips unsupported formats and propagates no-history failures', async () => {
    // Recognition asks about SEUR's longer numbers only.
    const long = '99000000000002'; const asked = (body = copy()) => ({ ...body, identificador_busqueda: long });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(asked())); const instance = adapter(environment(fetcher));
    expect(await instance.recognize!('unsupported')).toEqual({ known: false }); expect(fetcher).not.toHaveBeenCalled();
    expect(await instance.recognize!(long)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-23T13:13:05' });
    const body0 = copy(); body0.situaciones[0]!.fecha = '2026-01-23T13:13:05+01:00';
    const offset = vi.fn<typeof fetch>().mockResolvedValue(response(asked(body0)));
    expect(await adapter(environment(offset)).recognize!(long)).toEqual({ known: true, lastActivityAt: '2026-01-23T12:13:05.000Z' });
    const unresolved = vi.fn<typeof fetch>().mockResolvedValue(response(noHistory));
    await expect(adapter(environment(unresolved)).recognize!(long)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    const body = copy(); body.situaciones.forEach(scan => { scan.fecha = ''; }); const undated = vi.fn<typeof fetch>().mockResolvedValue(response(asked(body)));
    expect(await adapter(environment(undated)).recognize!(long)).toEqual({ known: true, lastActivityAt: null });
  });

  it('tracks a seven-digit expedition number but never asks recognition about one, since SEUR reuses them', async () => {
    const short = '0000007';
    expect(detectCarrierMatch(short).candidates).toContain('seur');
    expect(recognitionAskedCarriers(short)).not.toContain('seur');
    expect(recognitionCandidates(short, { hint: 'seur', countryHint: 'ES' }).map(({ carrier }) => carrier)).not.toContain('seur');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(await adapter(environment(fetcher)).recognize!(short)).toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    // The catalog asks recognition about exactly the numbers the adapter's recognition accepts.
    const pattern = new RegExp(CARRIER_DEFINITIONS.seur.tracking.recognitionPattern!);
    for (const number of [short, '0'.repeat(14), '0'.repeat(21), '2026010100000000000001', NUMBER]) {
      expect(pattern.test(number), number).toBe(accepted(() => normalizeSeurRecognitionNumber(number)));
    }
  });

  it('keeps generic HTTP failures distinct from shipment absence and bounds response bytes', async () => {
    for (const [status, kind] of [[302, 'indeterminate'], [404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(noHistory), { status }));
      await expect(new SeurTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_000_001)));
    await expect(new SeurTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Challenge</html>'));
    await expect(new SeurTracker({ fetcher: invalid }).fetch(NUMBER)).rejects.toThrow('invalid tracking response');
    const firewall = '<html>\r\n<head>\r\n<META NAME="robots" CONTENT="noindex,nofollow">\r\n<script src="/_Incapsula_Resource?SYNTHETIC=1"></script>\r\n</head></html>';
    const held = vi.fn<typeof fetch>().mockResolvedValue(new Response(firewall, { headers: { 'content-type': 'text/html' } }));
    await expect(new SeurTracker({ fetcher: held }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('preserves caller cancellation and rejects delayed positive responses beyond a fractional deadline', async () => {
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(new SeurTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new SeurTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const waiting = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((_resolve, reject) => { init?.signal?.throwIfAborted(); init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
      return response();
    });
    const active = new SeurTracker({ fetcher: waiting }).fetch(NUMBER, { signal: controller.signal }); controller.abort();
    await expect(active).rejects.toMatchObject({ kind: 'transport' }); expect(waiting).toHaveBeenCalledTimes(1);
    const late = vi.fn<typeof fetch>(async () => { await new Promise(resolve => setTimeout(resolve, 35)); return response(); });
    await expect(new SeurTracker({ fetcher: late }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: 'budget' });
  });
});
