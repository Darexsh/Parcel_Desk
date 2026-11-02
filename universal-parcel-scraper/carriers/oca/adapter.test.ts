import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OCA_API, OcaTracker } from './adapter.js';
import { normalizeOcaNumber, ocaWording, parseOca } from './parser.js';
import { ocaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '1234500000000000011';
const IN_TRANSIT = '1234500000000000022';
const UNKNOWN = '1234500000000000033';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/xml; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The robot check OCA's tracking page shows before a parcel's history.
const ROBOT_CHECK = '<!DOCTYPE html><html><head><title>Seguimientos - OCAWEB</title></head><body>'
  + '<h2>Para continuar, indicanos que no sos un robot</h2><div id="recaptcha" class="g-recaptcha" data-sitekey="sample"></div></body></html>';

/** The in-transit reply with its last rows replaced by these states, reasons and clocks. */
const continued = (rows: readonly (readonly [string, string, string])[]) => {
  const tables = rows.map(([clock, state, reason], index) => `      <Table diffgr:id="Table${20 + index}" msdata:rowOrder="${19 + index}">
        <NumeroEnvio>${IN_TRANSIT}</NumeroEnvio>
        <Descripcion_Motivo>${reason}</Descripcion_Motivo>
        <Desdcripcion_Estado>${state} - Suc: PUEBLO EJEMPLO</Desdcripcion_Estado>
        <SUC>Suc: PUEBLO EJEMPLO</SUC>
        <fecha>${clock}</fecha>
      </Table>`).join('\n');
  return fixture('in-transit').replace('    </NewDataSet>', `${tables}\n    </NewDataSet>`);
};

describe('OCA HTTP adapter', () => {
  it('asks the e-Pak tracking service for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OcaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 12345 0000 0000000022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${OCA_API}?NroDocumentoCliente=&CUIT=&Pieza=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'oca', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery in Argentina’s time, each state without its branch and the proof of delivery without a stage', () => {
    const result = parseOca(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Acuse digitalizado', last_update: '2026-05-12T11:05:41-03:00', expected_delivery: null,
      delivered_at: '2026-05-07T14:20:26-03:00' });
    // The repeated transit row is kept once.
    expect(result.events!.map((event) => [event.time, event.description, event.location, event.stage ?? null])).toEqual([
      ['2026-05-12T11:05:41-03:00', 'Acuse digitalizado', 'PLANTA DE MUESTRA', null],
      ['2026-05-07T14:20:59-03:00', 'Entregado', 'VILLA EJEMPLO', 'delivered'],
      ['2026-05-07T14:20:26-03:00', 'Estado de Visita ONLINE (Entregado)', 'VILLA EJEMPLO', 'delivered'],
      ['2026-05-07T06:41:00-03:00', 'Visita a Domicilio en Curso', 'VILLA EJEMPLO', 'out_for_delivery'],
      ['2026-05-07T06:40:12-03:00', 'Programado para visita a domicilio', 'VILLA EJEMPLO', 'out_for_delivery'],
      ['2026-05-07T05:31:30-03:00', 'Arribado a Centro de Distribución de Destino', 'VILLA EJEMPLO', 'in_transit'],
      ['2026-05-06T03:02:11-03:00', 'En viaje a Centro de Distribución de Destino', 'CENTRO DE MUESTRA', 'in_transit'],
      ['2026-05-06T01:15:49-03:00', 'Procesado en OCA', 'CENTRO DE MUESTRA', 'in_transit'],
      ['2026-05-06T01:15:44-03:00', 'En Proceso en OCA', 'CENTRO DE MUESTRA', 'in_transit'],
      ['2026-05-05T18:40:02-03:00', 'Retirado en Origen', 'CENTRO DE MUESTRA', 'accepted'],
      ['2026-05-04T09:12:30-03:00', 'En proceso de Retiro', 'CENTRO DE MUESTRA', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.provider_code === undefined)).toBe(true);
  });

  it('keeps the reason of a visit that did not deliver and puts the later of two rows in one second first', () => {
    const result = parseOca(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Reprogramado para nueva visita (Domicilio cerrado)', last_update: '2026-06-06T06:55:47-03:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.stage])).toEqual([
      ['Reprogramado para nueva visita (Domicilio cerrado)', 'failed_attempt'],
      // The state already names its reason, with the service's padding.
      ['No entregado (Domicilio cerrado)', 'failed_attempt'],
    ]);
    expect(result.events!.slice(-4).map((event) => [event.time, event.description])).toEqual([
      ['2026-06-02T22:12:13-03:00', 'Procesado en OCA'],
      ['2026-06-02T22:12:13-03:00', 'En Proceso en OCA'],
      ['2026-06-02T17:46:28-03:00', 'Retirado en Origen'],
      ['2026-06-01T00:00:00-03:00', 'En proceso de Retiro'],
    ]);
  });

  it('reads a return to the sender and a later pickup at the branch', () => {
    const returned = parseOca(continued([
      ['2026-06-08 09:30:07.000', 'Devolución en Proceso', 'Solicitada por el cliente'],
      ['2026-06-09 08:27:16.110', 'Devuelto al Remitente', 'Solicitada por el cliente'],
    ]), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned',
      last_status_text: 'Devuelto al Remitente (Solicitada por el cliente)' });
    const collected = parseOca(continued([
      ['2026-06-08 07:05:16.113', 'En Espera de Retiro por Sucursal', 'Sin Motivo'],
      ['2026-06-08 17:32:14.250', 'Entregado', 'Sin Motivo'],
    ]), IN_TRANSIT);
    expect(collected).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-06-08T17:32:14-03:00' });
    expect(collected.events![1]).toMatchObject({ description: 'En Espera de Retiro por Sucursal', stage: 'ready_for_pickup' });
  });

  it('words a state without the branch, with a reason it does not give already', () => {
    expect(ocaWording('Entregado - Suc: SAMPLE', 'Sin Motivo')).toBe('Entregado');
    expect(ocaWording('No entregado      (Ausente) - Suc: SAMPLE', 'Ausente')).toBe('No entregado (Ausente)');
    expect(ocaWording('Devolución en Proceso - Suc: SAMPLE', 'Solicitada por el cliente')).toBe('Devolución en Proceso (Solicitada por el cliente)');
    expect(ocaWording('Procesado en OCA', '')).toBe('Procesado en OCA');
    expect(ocaWording(' - Suc: SAMPLE', 'Ausente')).toBe('');
  });

  it('reads the empty dataset as not found and a dataset for another parcel as inconclusive', () => {
    expect(() => parseOca(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOca(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'OCA answered for another shipment' }));
    // One row for another parcel is enough.
    const mixed = fixture('delivered').replace(`<NumeroEnvio>${DELIVERED}</NumeroEnvio>`, `<NumeroEnvio>${UNKNOWN}</NumeroEnvio>`);
    expect(() => parseOca(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    const delivered = fixture('delivered');
    for (const [index, body] of [
      '',
      'Missing parameter: NroDocumentoCliente.',
      '<html><body>Server Error</body></html>',
      delivered.replace('<DataSet xmlns="#Oca_e_Pak">', '<DataSet xmlns="#Oca_Express_Pak">'),
      delivered.slice(0, -20),
      delivered.replace(/<diffgr:diffgram[^>]*>[\s\S]*<\/diffgr:diffgram>/, ''),
      delivered.replace('<NewDataSet xmlns="">', '<OtherDataSet xmlns="">').replace('</NewDataSet>', '</OtherDataSet>'),
      delivered.replace('<Table diffgr:id="Table1" msdata:rowOrder="0">', '<Row>').replace('</Table>', '</Row>'),
      delivered.replace('<fecha>2026-05-04 09:12:30.120</fecha>', '<fecha>04/05/2026 09:12</fecha>'),
      delivered.replace('<fecha>2026-05-04 09:12:30.120</fecha>', '<fecha>2026-02-30 09:12:30.120</fecha>'),
      delivered.replace('<fecha>2026-05-04 09:12:30.120</fecha>', '<fecha>2026-05-04 24:00:00.000</fecha>'),
      delivered.replace('<fecha>2026-05-04 09:12:30.120</fecha>', ''),
      delivered.replace(`<NumeroEnvio>${DELIVERED}</NumeroEnvio>`, ''),
      delivered.replace('<Desdcripcion_Estado>Entregado - Suc: VILLA EJEMPLO</Desdcripcion_Estado>', '<Desdcripcion_Estado> - Suc: VILLA EJEMPLO</Desdcripcion_Estado>'),
      delivered.replace('<SUC>Suc: VILLA EJEMPLO</SUC>', '<SUC>Suc: VILLA EJEMPLO</SUC><SUC>Suc: OTRA</SUC>'),
      delivered.replace('<SUC>Suc: VILLA EJEMPLO</SUC>', '<SUC><b>VILLA EJEMPLO</b></SUC>'),
    ].entries()) {
      expect(() => parseOca(body, DELIVERED), `change ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a robot check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.oca.com.ar/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(ROBOT_CHECK, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>OCA</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The service's own failure for a malformed query.
    await expect(lookup('Missing parameter: Pieza.', { status: 500, headers: { 'Content-Type': 'text/plain' } }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty dataset, and asks nothing for a number OCA does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T14:05:41.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('12345000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers OCA does not issue and pre-aborted lookups without a request, and tracks a piece by its parcel', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123450000000000001', '12345000000000000111', 'AB123456789AR', `${DELIVERED}-12`, `${DELIVERED}-A`, '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeOcaNumber(`${DELIVERED}-1`)).toBe(DELIVERED);
    expect(normalizeOcaNumber(' 12345-0000-0000000011 - 3 ')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under OCA to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'oca' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'oca', source: 'oca', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(OCA_API))).toBe(true);
  });
});

describe('OCA status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(ocaStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'oca', description: entry.wording }), entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(ocaStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'oca', description: 'No entregado (Domicilio cerrado)' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'oca', description: 'Estado sintético' })).toEqual({ kind: 'unknown' });
    // A state the map does not know falls to the shared wording rules.
    expect(ocaStage('Estado de Visita ONLINE (Entregado al portero)')).toMatchObject({ source: expect.stringMatching(/^wording:/) });
    expect(ocaStage('Estado sintético')).toBeNull();
  });
});
