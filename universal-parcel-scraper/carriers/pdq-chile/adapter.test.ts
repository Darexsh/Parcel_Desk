import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PDQ_API, PdqTracker } from './adapter.js';
import { normalizePdqNumber, parsePdq } from './parser.js';
import { pdqMappedStage, pdqStage, pdqSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = '700000000000';
const DELIVERED = '700000000017';
const IN_TRANSIT = '700000000025';

type Row = Record<string, unknown>;
type Shipment = Row & { eventos: Row[] };
type Reply = Row & { expedicion: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.expedicion, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's block page, in front of the site.
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';
const PERSONAL = /Sample Person|Conductor|123456|9990000|Fono|900000000|SAMPLE-000|SAMPLEREF|AAA|Sample Origin/i;

describe('PDQ HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole guide number once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PdqTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 7000 0000-0025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PDQ_API}?q=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Referer: 'https://www.pdq.cl/tracking', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pdq-chile', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and branch, stages it by its code and keeps the estimated day', () => {
    const result = parsePdq(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Llego a tu ciudad', last_update: null, last_update_local: '2026-04-02T08:03:00', expected_delivery: '2026-04-03' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-04-02T08:03:00', 'LLEG', 'in_transit', 'Sample Port'],
      ['2026-04-01T22:47:00', 'CPCE', 'in_transit', 'Cd Sample'],
      ['2026-04-01T15:10:00', 'ALTA', 'registered', 'Cd Sample'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('pickup_point');
  });

  it('keeps the delivery and the failed attempt before it, without the detail lines, the references, the postcode or who received it', () => {
    const result = parsePdq(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update_local: '2026-03-13T16:42:00', expected_delivery: null });
    // The repeated delivery round is kept once; the failed attempt's code is staged by its wording.
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['ENTR', 'delivered', 'carrier_map'],
      ['REPA', 'out_for_delivery', 'carrier_map'],
      ['DIAN', 'failed_attempt', 'wording:language'],
      ['REPA', 'out_for_delivery', 'carrier_map'],
      ['LLEG', 'in_transit', 'carrier_map'],
      ['CPCE', 'in_transit', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('reads the page’s notice to collect the parcel at a branch as ready for pickup there, and keeps the branch after the collection', () => {
    const notice = { tipo: 'retiro-oficina', desde: { fecha: '2026-04-02', hora: '10:00' }, delegacion: { codigo: 902, nombre: 'Sample Port' }, portesDebidos: true };
    const waiting = parsePdq(changed('in-transit', (shipment) => { shipment.aviso = notice; shipment.estado = 'REPARTO'; }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      pickup_point: 'PDQ Sample Port', expected_delivery: null });
    const collected = parsePdq(changed('delivered', (shipment) => { shipment.aviso = notice; }), DELIVERED);
    expect(collected).toMatchObject({ current_stage: 'delivered', pickup_point: 'PDQ Sample Port' });
    // Another notice is no pickup.
    expect(parsePdq(changed('in-transit', (shipment) => { shipment.aviso = { ...notice, tipo: 'sample' }; }), IN_TRANSIT))
      .not.toHaveProperty('pickup_point');
  });

  it('takes the shipment’s word for a delivery, and its step when no scan has a stage', () => {
    const delivered = parsePdq(changed('in-transit', (shipment) => {
      shipment.estado = 'Entregada';
      shipment.eventos.unshift({ fecha: '2026-04-02', hora: '17:00', descripcion: 'Sample closure', codigo: 'CLEN' });
    }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sample closure', expected_delivery: null });
    expect(delivered.events![0]).not.toHaveProperty('stage');
    const stepped = parsePdq(changed('in-transit', (shipment) => {
      shipment.estado = 'TRÁNSITO';
      shipment.eventos = [{ fecha: '2026-04-01', hora: '22:47', descripcion: 'Sample scan', codigo: 'ZZZZ' }];
    }), IN_TRANSIT);
    expect(stepped).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Sample scan' });
  });

  it('keeps a shipment without scans as its step alone, and one without a step either as no history', () => {
    const registered = parsePdq(changed('in-transit', (shipment) => { shipment.estado = 'EN PREPARACIÓN'; shipment.eventos = []; }), IN_TRANSIT);
    expect(registered).toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true,
      provider_code: 'EN PREPARACION', last_status_text: 'EN PREPARACIÓN', events: [] });
    expect(registered).not.toHaveProperty('last_update_local');
    expect(() => parsePdq(changed('in-transit', (shipment) => { shipment.estado = 'SAMPLE'; delete (shipment as Row).eventos; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parsePdq(changed('delivered', (shipment) => { shipment.eventos.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-13T16:42:00', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'CPCE' });
  });

  it('reads PDQ’s unknown-guide answer as not found, and keeps nothing of a reference match', () => {
    expect(() => parsePdq(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const ambiguous = { encontrado: false, motivo: 'ambiguo', referencia: UNKNOWN, cantidad: 3, pedir: 'comuna' };
    const several = { encontrado: false, motivo: 'multiple', referencia: UNKNOWN,
      envios: [{ numero: DELIVERED, destino: 'Sample Town', fechaAlta: '2026-03-11', bultos: 1, estado: 'ENTREGADA' }] };
    for (const answer of [ambiguous, several]) {
      expect(() => parsePdq(answer, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate',
        message: 'PDQ matched the number as a shipper reference, not a guide' }));
    }
    expect(() => parsePdq({ encontrado: false, motivo: 'error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdq({ encontrado: false, motivo: 'no-autorizado' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parsePdq({ encontrado: false, motivo: 'input-invalido' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parsePdq({ encontrado: false, motivo: 'sample' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePdq({ encontrado: false }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a shipment only when it carries the guide number asked', () => {
    expect(() => parsePdq(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PDQ answered for another shipment' }));
    expect(() => parsePdq(changed('in-transit', (shipment) => { shipment.numero = `${IN_TRANSIT}0`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdq(changed('in-transit', (shipment) => { shipment.numero = IN_TRANSIT.slice(1); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).encontrado; },
      (_shipment: Shipment, body: Reply) => { body.encontrado = 'true'; },
      (_shipment: Shipment, body: Reply) => { body.expedicion = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.numero; },
      (shipment: Shipment) => { shipment.numero = Number(IN_TRANSIT); },
      (shipment: Shipment) => { shipment.estado = 7; },
      (shipment: Shipment) => { shipment.eventos = 'events' as never; },
      (shipment: Shipment) => { shipment.eventos = Array.from({ length: 501 }, () => shipment.eventos[0]!); },
      (shipment: Shipment) => { shipment.eventos[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.eventos[0]!.fecha = '02/04/2026'; },
      (shipment: Shipment) => { shipment.eventos[0]!.fecha = '2026-02-30'; },
      (shipment: Shipment) => { shipment.eventos[0]!.hora = '08:03:00'; },
      (shipment: Shipment) => { shipment.eventos[0]!.hora = '24:00'; },
      (shipment: Shipment) => { delete shipment.eventos[0]!.hora; },
      (shipment: Shipment) => { shipment.eventos[0]!.descripcion = ['Llego']; },
      (shipment: Shipment) => { shipment.eventos[0]!.descripcion = ' '; },
      (shipment: Shipment) => { shipment.eventos[0]!.codigo = 7; },
      (shipment: Shipment) => { shipment.eventos[0]!.delegacion = 'Sample Port'; },
      (shipment: Shipment) => { shipment.aviso = 'retiro-oficina'; },
    ]) {
      expect(() => parsePdq(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guide, a refusal, a block page, a moved route and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup turns away a request without its site's Referer with its own answer.
    await expect(lookup({ encontrado: false, motivo: 'no-autorizado' }, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ encontrado: false, motivo: 'input-invalido' }, { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(BLOCKED, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>404: This page could not be found.</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 308, headers: { Location: 'https://www.pdq.cl/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>PDQ</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known guide and the unknown-guide answer, and asks nothing for a number PDQ does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-13T16:42:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('7000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers PDQ does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['70000000001', '7000000000170', '70000000001X', 'SAMPLE-0001', '7000000000170AAA', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePdqNumber(' 7000-0000.0017 ')).toBe(DELIVERED);
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

  it('routes a guide filed under PDQ to the adapter, and leaves the twelve-digit shape unclaimed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pdq-chile' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pdq-chile', source: 'pdq-chile', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(PDQ_API))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('pdq-chile');
  });
});

describe('PDQ status vocabulary', () => {
  it('maps every recorded code and step to the stage it records, and the parser stages coded scans the same way', () => {
    const entries = statuses.entries as { code?: string; wording?: string; stage: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      if (!entry.code) {
        // The shipment's `estado`, a step of the page's rail.
        expect(pdqSummaryStage(entry.wording!), entry.wording).toBe(entry.stage);
        continue;
      }
      expect(pdqMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording ?? '')), entry.code).toBe(entry.stage);
      // Codes seen only on the page's rail come without a wording.
      if (!entry.wording) continue;
      expect(statusMapAnswer({ carrier: 'pdq-chile', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(pdqStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    for (const event of parsePdq(fixture('delivered'), DELIVERED).events!.filter((scan) => scan.stage_source === 'carrier_map')) {
      expect(statusMap.stage(event.provider_code!, normalizeStatusWording(event.description!)), event.description).toBe(event.stage);
    }
    // A code the map does not know falls to the shared wording rules.
    expect(statusMapAnswer({ carrier: 'pdq-chile', providerCode: 'DIAN', description: 'No entregado' })).toEqual({ kind: 'unknown' });
    expect(pdqStage('DIAN', 'No entregado')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(pdqStage('ZZZZ', 'Sample note')).toBeNull();
    expect(pdqStage('entr', 'Sample note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(pdqSummaryStage('Sample')).toBeUndefined();
  });
});
