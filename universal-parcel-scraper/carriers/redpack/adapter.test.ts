import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, REDPACK_TOKEN_URL, REDPACK_TRACKING_URL, RedpackTracker } from './adapter.js';
import { parseRedpack } from './parser.js';
import { redpackStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000101';
const COLLECTED = '900000102';
const FAILING = '900000108';
const UNKNOWN = '900000109';
const TOKEN = 'synthetic-session-token-0001';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Parcel = { situationDetail: Row[] } & Row;
type Guide = { parcel: Parcel[] | null; consumptionResultWS: Row[] } & Row;
const fixture = (name: string): [Guide] => JSON.parse(text(name)) as [Guide];
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const grant = (token = TOKEN) => json(JSON.stringify({ access_token: token, token_type: 'bearer', refresh_token: 'synthetic-refresh',
  expires_in: 1199, scope: 'read write', name: 'SYNTHETIC ACCOUNT', email: 'account@example.invalid' }));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
type Details = { request?: unknown; diagnostics?: unknown };

/** A transport that signs the app in and answers the tracking service with the given replies in turn. */
function redpack(...replies: (() => Response | Promise<Response>)[]) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input) === REDPACK_TOKEN_URL) return grant();
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return next();
  });
}

describe('Redpack HTTP adapter', () => {
  it("signs in with the app's account once and posts the whole number with its token", async () => {
    const fetcher = redpack(() => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new RedpackTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 900 000 101 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([REDPACK_TOKEN_URL, REDPACK_TRACKING_URL, REDPACK_TRACKING_URL]);
    const [, signIn] = fetcher.mock.calls[0]!;
    expect(signIn).toMatchObject({ method: 'POST', body: 'grant_type=password&username=IKAMORA&password=amoral', signal: expect.any(AbortSignal),
      headers: { Authorization: `Basic ${btoa('app-redpack-web:R3dPack&2020')}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SyntheticHost/1.0' } });
    const [, track] = fetcher.mock.calls[1]!;
    expect(track).toMatchObject({ method: 'POST', body: JSON.stringify([{ trackingNumber: DELIVERED }]), signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'redpack', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(2);
  });

  it('reads a delivered guide newest first in central Mexico time, without the receiver, address, references or route notes', () => {
    const result = parseRedpack(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: '2026-03-05T13:47:02-06:00', delivered_at: '2026-03-05T13:47:02-06:00',
      expected_delivery: null, service_name: 'ECOEXPRESS', weight_kg: 2.5, dimensions_text: '30 × 20 × 12 cm', timezone: 'America/Mexico_City' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-03-05T13:47:02-06:00', '1', 'delivered', 'ENTREGADO', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-05T09:05:11-06:00', '3', 'out_for_delivery', 'EMBARCADO EN RUTA DE ENTREGA', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-04T16:20:45-06:00', '125', null, 'CONTROL DE ENVIOS', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-04T15:58:30-06:00', '125', null, 'CONTROL DE ENVIOS (DIRECCION INCORRECTA)', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-03T18:31:09-06:00', '8', 'failed_attempt', 'NO ENTREGADO (DIRECCION INCORRECTA)', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-03T09:40:00-06:00', '3', 'out_for_delivery', 'EMBARCADO EN RUTA DE ENTREGA (PRIMERA VISITA)', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-03T06:02:15-06:00', '42', 'in_transit', 'RECIBIDO EN OFICINA', 'CENTRO DESTINO, PUEBLA'],
      ['2026-03-02T22:10:05-06:00', '43', 'in_transit', 'SALIDA DE OFICINA', 'AEREO EJEMPLO'],
      ['2026-03-02T19:44:51-06:00', '42', 'in_transit', 'RECIBIDO EN OFICINA', 'AEREO EJEMPLO'],
      ['2026-03-02T08:12:40-06:00', '9', 'registered', 'REGISTRADO EN SISTEMA', 'VILLA ORIGEN, JALISCO'],
    ]);
    const kept = JSON.stringify(result);
    for (const dropped of ['SYNTHETIC RECEIVER', 'COLONIA EJEMPLO', '99999', '00000', 'EXAMPLE-REF', 'CTO:', 'CIRCUITO', 'PAQUETE']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('keeps the promised day before delivery, and reads a guide reduced to its pickup', () => {
    const moving = fixture('delivered');
    moving[0].parcel![0]!.situationDetail.splice(0, 1);
    expect(parseRedpack(moving, DELIVERED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      expected_delivery: '2026-03-04', last_update: '2026-03-05T09:05:11-06:00' });
    const collected = parseRedpack(fixture('collected'), COLLECTED);
    expect(collected).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'ENVIO RECOLECTADO',
      expected_delivery: null, events: [{ time: '2025-11-20T10:15:30-06:00', description: 'ENVIO RECOLECTADO', stage: 'accepted', stage_source: 'carrier_map' }] });
    expect(collected.events![0]).not.toHaveProperty('provider_code');
    expect(collected.events![0]).not.toHaveProperty('location');
    expect(collected).not.toHaveProperty('weight_kg');
    expect(collected).not.toHaveProperty('dimensions_text');
  });

  it('drops the scans a second parcel repeats, reads a found guide without scans as a summary and keeps a real offset', () => {
    const twice = fixture('delivered');
    twice[0].parcel!.push(structuredClone(twice[0].parcel![0]!));
    const result = parseRedpack(twice, DELIVERED);
    expect(result.events).toHaveLength(10);
    expect(result).not.toHaveProperty('weight_kg');
    const bare = fixture('delivered');
    bare[0].parcel = null;
    expect(parseRedpack(bare, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true,
      last_status_text: 'ENTREGADO', last_update: null, events: [] });
    const offset = fixture('collected');
    offset[0].parcel![0]!.situationDetail[0]!.date = '2025-11-20T10:15:30.250-05:00';
    expect(parseRedpack(offset, COLLECTED).events![0]!.time).toBe('2025-11-20T10:15:30-05:00');
  });

  it('binds the reply to the whole requested number and rejects malformed replies', () => {
    expect(() => parseRedpack(fixture('delivered'), '900000100')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = [...fixture('delivered'), ...fixture('delivered')];
    expect(() => parseRedpack(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = fixture('delivered');
    undated[0].parcel![0]!.situationDetail[1]!.date = '05/03/2026 09:05';
    expect(() => parseRedpack(undated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const unresulted = fixture('delivered');
    unresulted[0].consumptionResultWS = [];
    expect(() => parseRedpack(unresulted, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRedpack({ error: 'Bad Request' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRedpack(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRedpack(fixture('not-found'), '900000100')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRedpack(fixture('error'), FAILING)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = fixture('not-found');
    mixed[0].consumptionResultWS.push({ status: 1, description: 'GENERACIÓN CORRECTA', severity: 3 });
    expect(() => parseRedpack(mixed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes a known guide and an unknown one, and leaves a failing lookup open', async () => {
    const fetcher = redpack(() => json(text('delivered')), () => json(text('not-found')), () => json(text('error')));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T19:47:02.000Z' });
    await expect(direct.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(direct.recognize!(FAILING)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct.recognize!('9000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(carrier(redpack(() => json(text('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('signs in again once when the tracking service rejects the token', async () => {
    const fetcher = redpack(() => json('{"error":"invalid_token"}', 401), () => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new RedpackTracker({ fetcher, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([REDPACK_TOKEN_URL, REDPACK_TRACKING_URL, REDPACK_TOKEN_URL, REDPACK_TRACKING_URL]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok' }));
    const refused = redpack(() => json('{"error":"invalid_token"}', 401));
    await expect(carrier(refused).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(refused).toHaveBeenCalledTimes(4);
  });

  it('opens one session for lookups that start together', async () => {
    const fetcher = redpack(() => json(text('delivered')));
    const tracker = new RedpackTracker({ fetcher });
    await Promise.all([tracker.fetch(DELIVERED), tracker.fetch(DELIVERED)]);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === REDPACK_TOKEN_URL)).toHaveLength(1);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the tracking service as %s, without the token in the error', async (status, kind) => {
      const fetcher = redpack(() => json('{"error":"synthetic"}', status));
      const error = await carrier(fetcher).track({ number: DELIVERED }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
      expect([(error as Details).request, (error as Details).diagnostics]).toEqual([undefined, undefined]);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it("keeps a refused sign-in, a broken session reply and a malformed answer apart from a missing guide", async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValue(json('{"error":"invalid_grant","error_description":"Bad credentials"}', 400));
    const error = await carrier(refused).track({ number: DELIVERED }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'challenge' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('amoral');
    expect(refused).toHaveBeenCalledTimes(1);
    const tokenless = vi.fn<typeof fetch>().mockResolvedValue(json('{"token_type":"bearer"}'));
    await expect(carrier(tokenless).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    for (const body of ['<html>Service Unavailable</html>', '[]', '{"error":"Bad Request"}']) {
      await expect(carrier(redpack(() => new Response(body))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const fetcher = redpack(() => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return json(text('delivered'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new RedpackTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('rejects numbers Redpack does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9000001', '9000001010', 'RP90000010', '99999999999']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a guide filed under Redpack to the adapter', async () => {
    const fetcher = redpack(() => json(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'redpack' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'redpack', source: 'redpack', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => [REDPACK_TOKEN_URL, REDPACK_TRACKING_URL].includes(String(url)))).toBe(true);
  });
});

describe('Redpack status vocabulary', () => {
  it('records every code and wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(redpackStage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(redpackStage(null, 'EMBARCADO EN RUTA DE ENTREGA (PRIMERA VISITA)')).toBe('out_for_delivery');
    expect(redpackStage('999', 'Recolectado')).toBe('accepted');
    expect(redpackStage('999', 'En preparación')).toBe('registered');
    expect(statusMapAnswer({ carrier: 'redpack', providerCode: '1', description: 'ENTREGADO' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'redpack', providerCode: '125', description: 'CONTROL DE ENVIOS (DIRECCION INCORRECTA)' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'redpack', description: 'NO RECOLECTADO' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
