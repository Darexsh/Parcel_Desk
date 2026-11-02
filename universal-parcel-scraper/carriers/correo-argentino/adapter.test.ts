import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CorreoArgentinoTracker } from './adapter.js';
import { CORREO_ARGENTINO_LOOKUP, correoArgentinoLookupFields, parseCorreoArgentino } from './parser.js';
import { correoArgentinoScanStage, correoArgentinoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CP000000014AR';
const TRANSIT = 'SP000000028AR';
const INBOUND = 'RR000000031CN';
const RETURNED = 'CE000000059US';
const ABSENT = 'RR900000005AR';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseCorreoArgentino>) =>
  result.events!.map(event => [event.time ?? `local ${String(event.local_time)}`, event.description, event.location, event.stage]);
const failure = (run: () => unknown) => {
  try { run(); }
  catch (error) { return error as { kind?: string; message?: string }; }
  throw new Error('no failure');
};

type Answer = string | Response | (() => Response | Promise<Response>);

/** The tracker's lookup: each form answers the numbers it knows and the notice for the rest. */
function site(answers: Record<string, Answer> = {}) {
  const known: Record<string, Answer> = { [DELIVERED]: page('delivered'), [TRANSIT]: page('in-transit'), [INBOUND]: page('inbound'),
    [RETURNED]: page('returned'), ...answers };
  return vi.fn<typeof fetch>(async (_input, init) => {
    const fields = new URLSearchParams(String(init?.body ?? ''));
    const number = fields.get('action') === 'ondnc' ? `${fields.get('producto')}${fields.get('id')}${fields.get('pais')}` : fields.get('id')!;
    const answer = known[number] ?? page('not-found');
    const value = typeof answer === 'function' ? await answer() : answer;
    return typeof value === 'string' ? html(value) : value;
  });
}

describe('Correo Argentino tracking adapter', () => {
  it('posts an item numbered in Argentina to the national form, as the page’s script does', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new CorreoArgentinoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' cp 000 000 014 ar ', { budgetMs: 3000.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(CORREO_ARGENTINO_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(String(init.body)).toBe('action=ondnc&id=000000014&producto=CP&pais=AR');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correo-argentino', step: 'direct', outcome: 'ok' }));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'INTENTO DE ENTREGA: ENTREGADO', last_update: '2026-03-18T11:42:00-03:00',
      delivered_at: '2026-03-18T11:42:00-03:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-18T11:42:00-03:00', 'INTENTO DE ENTREGA: ENTREGADO', 'CDD 04 VILLA EJEMPLO', 'delivered'],
      ['2026-03-18T08:05:00-03:00', 'EN PODER DEL CARTERO', 'CDD 04 VILLA EJEMPLO', 'out_for_delivery'],
      ['2026-03-17T15:20:00-03:00', 'INTENTO DE ENTREGA: DOMICILIO CERRADO/1 VISITA', 'CDD 04 VILLA EJEMPLO', 'failed_attempt'],
      ['2026-03-17T08:10:00-03:00', 'EN PODER DEL CARTERO', 'CDD 04 VILLA EJEMPLO', 'out_for_delivery'],
      ['2026-03-17T06:30:00-03:00', 'LLEGADA AL CENTRO DE PROCESAMIENTO', 'CDD 04 VILLA EJEMPLO', 'in_transit'],
      ['2026-03-16T23:48:00-03:00', 'EN PROCESO DE CLASIFICACIÓN', 'CTP CIUDAD UNO', 'in_transit'],
      ['2026-03-16T21:15:00-03:00', 'LLEGADA AL CENTRO DE PROCESAMIENTO', 'CTP CIUDAD UNO', 'in_transit'],
      ['2026-03-16T10:02:00-03:00', 'INGRESO AL CORREO', 'UP SUCURSAL DEMO', 'accepted'],
    ]);
  });

  it('reads an item still in Argentina’s network, without its customs box', async () => {
    const result = await carrier(site()).track({ number: TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-04-07T09:12:00-03:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result).at(-2)).toEqual(['2026-04-02T11:30:00-03:00', 'EN PROCESO DE IMPORTACIÓN (*)', 'CTP CPI-CIUDAD UNO', 'customs']);
    expect(JSON.stringify(result)).not.toMatch(/AFIP|aprobado|pago/);
  });

  it('posts an item from abroad to the international form and joins both histories, abroad on local clocks', async () => {
    const fetcher = site();
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(String(fetcher.mock.calls[0]![1]!.body)).toBe(`action=oidn&id=${INBOUND}`);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Deliver item (Inb)',
      last_update: null, last_update_local: '2026-02-19T16:50:00', delivered_at: '2026-02-19T13:50:00-03:00' });
    expect(rows(result)).toEqual([
      ['local 2026-02-19T16:50:00', 'Deliver item (Inb)', 'ZONA 9 SINTETICA, Argentina', 'delivered'],
      ['2026-02-19T13:50:00-03:00', 'INTENTO DE ENTREGA: ENTREGA EN SUCURSAL', 'CDD 04 VILLA EJEMPLO', 'delivered'],
      ['2026-02-17T10:15:00-03:00', 'INTENTO DE ENTREGA: EN ESPERA EN SUCURSAL', 'CDD 04 VILLA EJEMPLO', 'ready_for_pickup'],
      ['2026-02-17T09:00:00-03:00', 'LLEGADA AL CENTRO DE PROCESAMIENTO', 'CDD 04 VILLA EJEMPLO', 'in_transit'],
      ['local 2026-02-16T17:20:00', 'Send item to domestic location (Inb)', 'CIUDAD UNO AVION, Argentina', 'in_transit'],
      ['local 2026-02-16T17:10:00', 'Return item from customs (Inb)', 'CIUDAD UNO AVION, Argentina', 'in_transit'],
      ['local 2026-02-12T14:20:00', 'Send item to customs (Inb)', 'CIUDAD UNO AVION, Argentina', 'customs'],
      ['local 2026-02-12T14:20:00', 'Receive item at office of exchange (Inb)', 'CIUDAD UNO AVION, Argentina', 'in_transit'],
      ['2026-02-12T11:35:00-03:00', 'EN PROCESO DE IMPORTACIÓN (*)', 'CTP CPI-CIUDAD UNO', 'customs'],
      ['2026-02-12T11:20:00-03:00', 'LLEGADA DEL PAÍS', 'CTP CPI-CIUDAD UNO', 'in_transit'],
      ['local 2026-02-04T22:30:00', 'Send item abroad (EDI-received)', 'China', 'in_transit'],
      ['local 2026-02-03T09:05:00', 'Insert item into bag (Otb)', 'China', 'in_transit'],
      ['local 2026-02-03T08:40:00', 'Receive item at office of exchange (Otb)', 'China', 'in_transit'],
      ['local 2026-02-02T10:15:00', 'Receive item from customer (Otb)', 'ORIGENTOWN, China', 'accepted'],
    ]);
  });

  it('reads the movements after an item was left unclaimed as its return', async () => {
    const result = await carrier(site()).track({ number: RETURNED });
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'SALIDA DEL PAÍS', last_update: '2026-02-20T12:02:00-03:00' });
    expect(rows(result)).toEqual([
      ['2026-02-20T12:02:00-03:00', 'SALIDA DEL PAÍS', 'CTP CPI-CIUDAD UNO', 'returned'],
      ['local 2026-02-20T12:02:00', 'Insert item into bag (Otb)', 'CIUDAD UNO RETURN, Argentina', 'returned'],
      ['2026-02-14T11:00:00-03:00', 'INTENTO DE ENTREGA: PLAZO VENCIDO NO RECLAMO', 'ALMACENAJE DEMO', 'returned'],
      ['local 2026-01-17T12:30:00', 'Receive item at collection point for pick-up (Inb)', 'ZONA 9 SINTETICA, Argentina', 'ready_for_pickup'],
      ['2026-01-12T08:35:00-03:00', 'LLEGADA AL CENTRO DE PROCESAMIENTO', 'ALMACENAJE DEMO', 'in_transit'],
      ['2026-01-10T19:00:00-03:00', 'LLEGADA DEL PAÍS', 'CTP CPI-CIUDAD UNO', 'in_transit'],
      ['local 2026-01-10T19:00:00', 'Receive item at office of exchange (Inb)', 'CIUDAD UNO AVION, Argentina', 'in_transit'],
      ['local 2026-01-08T05:48:00', 'Send item abroad (EDI-received)', 'United States of America', 'in_transit'],
      ['local 2026-01-05T15:27:00', 'Receive item from customer (Otb)', 'SAMPLETON, United States of America', 'accepted'],
    ]);
  });

  it('reads an international reply before the item reached Argentina’s network, and one with a visit lacking its status', () => {
    const abroad = page('inbound').replace(/<div class="accordion"[\s\S]*$/, '');
    expect(parseCorreoArgentino(abroad, INBOUND)).toMatchObject({ current_stage: 'delivered', events: { length: 9 } });
    const visit = page('delivered').replace('<td data-title="Estado:">ENTREGADO</td>', '<td data-title="Estado:"></td>');
    const result = parseCorreoArgentino(visit, DELIVERED);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'INTENTO DE ENTREGA' });
    expect(result.events![0]!.stage).toBeUndefined();
    // A newest-first table whose two newest scans share a minute keeps them in the reply's order.
    const tie = page('delivered').replace('18-03-2026 08:05', '18-03-2026 11:42');
    expect(rows(parseCorreoArgentino(tie, DELIVERED)).slice(0, 2).map(row => row[1])).toEqual(['INTENTO DE ENTREGA: ENTREGADO', 'EN PODER DEL CARTERO']);
  });

  it('reads only the tracker’s own notice as a missing item, on either form', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).track({ number: 'RR000000014DE' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([, init]) => String(init?.body))).toEqual([
      'action=ondnc&id=900000005&producto=RR&pais=AR', 'action=oidn&id=RR000000014DE']);
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    const failed = '<div class="alert alert-info"><a class="close" data-dismiss="alert">&times;</a>No fue posible realizar la consulta en este momento. Por favor, inténtelo nuevamente</div>';
    const notice = '<br />\n<b>Notice</b>:  Undefined property: stdClass::$producto in /var/www/synthetic/wsFacade.php on line 1<br />\n' + page('not-found');
    for (const body of [failed, notice]) {
      await expect(carrier(site({ [ABSENT]: body })).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('keeps a block page, even with HTTP 200, as a challenge', async () => {
    for (const answer of [page('blocked'), () => html(page('blocked'), 403), () => html('Forbidden', 403)]) {
      await expect(carrier(site({ [DELIVERED]: answer })).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it.each([[429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without a retry', async (status, kind) => {
      const fetcher = site({ [DELIVERED]: () => html('<html><body>Unavailable</body></html>', status) });
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects a changed or incomplete reply as a schema failure', () => {
    for (const body of [
      '',
      '<html><body><p>Mantenimiento</p></body></html>',
      page('delivered').replace('<th>Planta</th>', '<th>Sucursal</th>'),
      page('delivered').replace('<span class="badge">8</span>', '<span class="badge">9</span>'),
      page('delivered').replace(/<div class="row-fluid">[\s\S]*?<\/div>/, ''),
      page('delivered').replace('18-03-2026 11:42', '2026-03-18 11:42'),
      page('delivered').replace('18-03-2026 11:42', '31-02-2026 11:42'),
      page('delivered').replace('<td data-title="Estado:">ENTREGADO</td>', ''),
      page('delivered').replace(/<p>Resultados[^\n]*\n/, ''),
    ]) {
      expect(failure(() => parseCorreoArgentino(body, DELIVERED)), body.slice(0, 80)).toMatchObject({ kind: 'schema' });
    }
    for (const body of [
      page('inbound').replace('<th> Planta </th>', '<th> Oficina </th>'),
      page('inbound').replace(/<table[\s\S]*?<\/table>/, match => `${match}${match}`),
      page('inbound').replace('Cantidad de movimientos', 'Movimientos'),
    ]) {
      expect(failure(() => parseCorreoArgentino(body, INBOUND))).toMatchObject({ kind: 'schema' });
    }
    // The international history answers only for an item from abroad.
    expect(failure(() => parseCorreoArgentino(page('inbound').replace('RR000000031CN', DELIVERED), DELIVERED))).toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole number asked', async () => {
    for (const [number, body] of [[DELIVERED, page('delivered').replace('CP-000000014-AR', 'CP-000000028-AR')],
      [INBOUND, page('inbound').replace('RR000000031CN', 'RR000000031DE')]] as const) {
      await expect(carrier(site({ [number]: body })).track({ number })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    expect(parseCorreoArgentino(page('inbound').replace('RR000000031CN', 'rr000000031cn'), INBOUND)).toMatchObject({ status: 'delivered' });
  });

  it('refuses a number that is not an S10 item code without a request', async () => {
    const fetcher = site();
    for (const number of ['CP000000015AR', 'CP00000001AR', '1234567890', 'CP000000014ARX']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(correoArgentinoLookupFields('RR000000031CN').toString()).toBe('action=oidn&id=RR000000031CN');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site({ [DELIVERED]: () => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(page('delivered'));
    } });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(down).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('bounds the size of a reply', async () => {
    const large = site({ [DELIVERED]: () => new Response(new Uint8Array(1_100_000)) });
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Correo Argentino to the adapter, while detection leaves S10 codes with the postal fallback', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: INBOUND, carrier: 'correo-argentino' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'correo-argentino', source: 'correo-argentino', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
  });
});

describe('Correo Argentino status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(correoArgentinoScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(correoArgentinoScanStage('INTENTO DE ENTREGA: DOMICILIO CERRADO/2 VISITA')).toBe('failed_attempt');
    expect(correoArgentinoScanStage('Deliver item (Domestic)')).toBe('delivered');
    for (const wording of ['constructor', 'ENTREGADO', 'INTENTO DE ENTREGA: ', 'Deliver item (Abroad)']) {
      expect(correoArgentinoScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('X1', 'en poder del cartero')).toBeUndefined();
    // A visit without its status has no stage; other wording goes to the shared rules.
    expect(correoArgentinoStage('INTENTO DE ENTREGA')).toBeNull();
    expect(correoArgentinoStage('INTENTO DE ENTREGA: RECHAZADO')).toMatchObject({ stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'correo-argentino', description: 'EN PODER DEL CARTERO' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'correo-argentino', description: 'INTENTO DE ENTREGA' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
