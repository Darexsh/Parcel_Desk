import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import type { StepRecord } from '../../core/telemetry/index.js';
import { resultTimezone } from '../../core/time/result.js';
import { CorreosExpressTracker, adapter } from './adapter.js';
import {
  correosExpressFeedResult, fixedExplanation, normalizeCorreosExpressNumber, parseCorreosExpress, parseCorreosExpressFeed,
  type CorreosExpressFeed,
} from './parser.js';
import { classifyCorreosExpressStatus, correosExpressCodeLabel, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError, carrierErrorKind } from '../../core/errors/index.js';

const NUMBER = '9900000000000002';
const OTHER = '9900000000000003';
const LABEL = '99000000000000001999994', SHIPMENT = '9900000000000004';
const FAILED_ROUND = 'Su envío no ha podido ser entregado';
const FORM = 'https://s.correosexpress.com/SeguimientoSinCP/search';
const FORM_PT = 'https://s.correosexpress.com/SeguimientoSinCP/search-pt';
const FEED = 'https://localizador.correos.es/canonico/eventos_envio_servicio/';
const html = readFileSync(new URL('./fixtures/history.html', import.meta.url), 'utf8');
const explained = readFileSync(new URL('./fixtures/explained.html', import.meta.url), 'utf8');
const failedRound = readFileSync(new URL('./fixtures/failed-round.html', import.meta.url), 'utf8');
const portuguese = readFileSync(new URL('./fixtures/portuguese.html', import.meta.url), 'utf8');
const feedText = readFileSync(new URL('./fixtures/feed.json', import.meta.url), 'utf8');
type Envelope = Record<string, unknown> & { eventos: Record<string, unknown>[] | null };
const feedPayload = (change: (envelope: Envelope) => void = () => {}) => {
  const payload = JSON.parse(feedText) as [Envelope];
  change(payload[0]);
  return payload;
};
const noTrace = (number = NUMBER) => feedPayload((envelope) => {
  Object.assign(envelope, { codEnvio: number, eventos: null, enviosAsociados: null, error: { codError: '3', desError: 'Sin Trazabilidad en Minerva.' } });
});
const feed = parseCorreosExpressFeed(feedPayload(), NUMBER)!;
const response = (body = html) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const edit = (change: (document: ReturnType<typeof load>) => void, source = html) => { const $ = load(source); change($); return $.html(); };
const negative = (number = NUMBER, code = '2') => `<html><head><title>Sigue tu envío- correosexpress.com</title></head><body>
  <form id="desktopHomeForm"><input name="shippingNumber" value="${number}"><input name="errorCode" value="${code}"></form>
  <form id="mobileHomeForm"><input name="shippingNumber" value="${number}"><input name="errorCode" value="${code}"></form>
  <div class="errorMessage2"><span class="errorMessage">Lo sentimos, no se ha encontrado ningún envío con el número indicado.</span></div>
  <div class="errorMessage-1">Lo sentimos, se ha producido un error durante la búsqueda del envío.</div></body></html>`;
/** A fetcher that answers the form and the localizador each with its own reply. */
const routed = (form: () => Response | Promise<Response>, localizador: () => Response | Promise<Response> = () => json(noTrace())) =>
  vi.fn(async (url: string | URL | Request) => (String(url).startsWith(FORM) ? form() : localizador())) as unknown as typeof fetch;
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });
const urls = (fetcher: typeof fetch) => vi.mocked(fetcher).mock.calls.map(([url]) => String(url));
const EXPLAINED = {
  INFORMADO: 'Ya hemos recibido la información de su envío, en breve dispondremos de su mercancía. Si necesita información adicional por favor póngase en contacto con su remitente.',
  EN_RUTA: 'Su envío está en uno de nuestro vehículos siendo transportado a la localidad de destino. Lo recibirá en la fecha de entrega prevista.',
  EN_DESTINO: 'Su envío está en nuestras instalaciones de destino y lo estamos clasificando. Lo recibirá en la fecha de entrega prevista.',
  EN_REPARTO: 'Su envío se encuentra en reparto. Lo recibirá en la fecha de entrega prevista.',
  ADDRESS: 'Su envío no ha podido ser entregado porque la dirección que tenemos es incompleta o incorrecta. Si desea gestionar una nueva entrega por favor pulse la opción Gestionar nueva entrega.',
};

describe('Correos Express direct tracking', () => {
  it('projects matching actual scans, their depots\' clocks, locality and date-only estimates without private details', () => {
    const result = normalizeCarrierResult(parseCorreosExpress(html, NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'NUEVO REPARTO',
      last_update: '2026-01-05T18:27:00+01:00', expected_delivery: '2026-01-06' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events).toHaveLength(7);
    expect(result.events?.[0]).toMatchObject({ time: '2026-01-05T18:27:00+01:00', location: 'BARCELONA2', provider_status: 'NUEVO REPARTO', stage: 'in_transit' });
    // Notes that are not the carrier's fixed sentences are dropped whole.
    expect(result.events?.map(event => event.description)).toEqual(['NUEVO REPARTO', 'EN ALMACÉN', 'EN REPARTO', 'EN DESTINO',
      'EN RUTA A LOCALIDAD DE DESTINO', 'ADMITIDO', 'INFORMADO']);
    // The host and aggregators relaying these wall clocks read them in Spanish time.
    expect(resultTimezone('correos-express', result)).toBe('Europe/Madrid');
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'exception', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    // Depots of mainland Spain and the head office keep Madrid's clock.
    expect(result.events?.map(event => event.time)).toEqual(['2026-01-05T18:27:00+01:00', '2026-01-02T10:01:00+01:00',
      '2026-01-02T09:00:00+01:00', '2026-01-01T12:00:00+01:00', '2026-01-01T06:03:00+01:00', '2025-12-31T13:15:00+01:00',
      '2025-12-30T13:15:00+01:00']);
    expect(result.events?.every(event => !event.local_time && !event.provider_code)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    expect(classifyCorreosExpressStatus('constructor')).toBeUndefined();
  });

  it('keeps the fixed sentences that explain a label and drops what follows them', () => {
    const result = parseCorreosExpress(explained, NUMBER);
    expect(result.events?.map(event => event.description)).toEqual(['NUEVO REPARTO', `EN ALMACÉN. ${EXPLAINED.ADDRESS}`,
      `EN REPARTO. ${EXPLAINED.EN_REPARTO}`, 'EN DESTINO', `EN RUTA A LOCALIDAD DE DESTINO. ${EXPLAINED.EN_RUTA}`, 'ADMITIDO',
      `INFORMADO. ${EXPLAINED.INFORMADO}`]);
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'exception', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.every(event => !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('maps every recorded label and situation code, and every situation to a mapped label', () => {
    for (const row of statuses.entries) {
      const wording = normalizeStatusWording(row.wording);
      if (row.code) {
        expect(statusMap.stage(row.code, wording), row.code).toBe(row.stage);
      } else {
        expect(classifyCorreosExpressStatus(row.wording)?.stage, row.wording).toBe(row.stage);
        expect(statusMap.stage(null, wording), row.wording).toBe(row.stage);
      }
    }
    for (const situation of ['01', '02', '04', '06', '08', '09', '10', '11', '12', '13', '14', '17', '38', '39']) {
      expect(classifyCorreosExpressStatus(correosExpressCodeLabel(`X${situation}0000V`)!), situation).toBeDefined();
    }
    expect(correosExpressCodeLabel('X070000V')).toBeUndefined();
    expect(correosExpressCodeLabel('A010000V')).toBeUndefined();
    // The descriptions the parser writes, read back as the app keys them.
    expect(statusMap.stage(null, normalizeStatusWording(`EN DESTINO. ${EXPLAINED.EN_DESTINO}`))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording(EXPLAINED.ADDRESS))).toBe('failed_attempt');
    expect(statusMap.stage(null, 'delivered')).toBe('delivered');
    expect(statusMap.stage('X070000V', 'tracking update')).toBeUndefined();
    expect(statusMap.codeKey?.('X090060R')).toBe('X09');
  });

  it('requires supported input and both independent shipment label and hidden field to match', () => {
    expect(normalizeCorreosExpressNumber('9900 0000 0000 0002')).toBe(NUMBER);
    expect(normalizeCorreosExpressNumber(`${NUMBER} 1234567`)).toBe(`${NUMBER}1234567`);
    for (const raw of ['', '123', NUMBER + '123456', NUMBER + '12345678', NUMBER + '?', 'A' + NUMBER.slice(1)]) expect(() => normalizeCorreosExpressNumber(raw)).toThrow(InvalidInputError);
    for (const changed of [edit($ => $('h3.status .shipping > span').text(OTHER)), edit($ => $('#shippingNumber').val(OTHER)),
      edit($ => $('.shipping').remove()), edit($ => $('h3.status').clone().appendTo('body')),
      edit($ => $('.shipping > span').clone().appendTo('.shipping')),
      edit($ => $('table.miyazaki').clone().appendTo('body')), edit($ => $('#shippingNumber').clone().appendTo('body'))]) {
      expect(() => parseCorreosExpress(changed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('accepts a parcel label whose page names the shipment it opens with, and reports that shipment', () => {
    const page = (shown: string, echoed = LABEL) => edit($ => { $('h3.status .shipping > span').text(shown); $('#shippingNumber').val(echoed); });
    const result = parseCorreosExpress(page(SHIPMENT), LABEL);
    expect(result).toMatchObject({ status: 'in_transit', canonical_tracking_number: SHIPMENT });
    expect(parseCorreosExpress(page(LABEL), LABEL).canonical_tracking_number).toBeUndefined();
    // A label opening with another first digit than its shipment's, as a Portuguese one did.
    const OPENED = '69000000000000001999997';
    expect(parseCorreosExpress(page(SHIPMENT, OPENED), OPENED)).toMatchObject({ canonical_tracking_number: SHIPMENT });
    // Another shipment, an echo of another label, a label whose own check digit fails, a shipment
    // whose check digit fails, and one that differs from the label beyond its first digit.
    for (const [changed, input] of [[page('9900000000000012'), LABEL], [page(SHIPMENT, '99000000000000002999993'), LABEL],
      [page(SHIPMENT, '99000000000000001999995'), '99000000000000001999995'], [page('9900000000000005', OPENED), OPENED],
      [page('6900000000000119', OPENED), OPENED]] as const) {
      expect(() => parseCorreosExpress(changed, input)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads an incident in customer service and the end of the pickup period', () => {
    const ended = 'EL PERIODO DE RECOGIDA DEL ENVÍO EN EL PUNTO DE CONVENIENCIA SELECCIONADO HA FINALIZADO Y SE PROCEDERÁ A SU DEVOLUCIÓN A ORIGEN';
    for (const [label, status, stage] of [['EN GESTIÓN', 'exception', 'exception'], [ended, 'exception', 'returned']] as const) {
      const result = parseCorreosExpress(edit($ => $('tbody tr').first().find('td').last().text(`${label}. PRIVATE_SYNTHETIC_NOTE`)), NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage, last_status_text: label, expected_delivery: null });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    }
    const explained = parseCorreosExpress(edit($ => $('tbody tr').first().find('td').last()
      .text(`${ended}.. Tiempo de recogida finalizado en Punto de Conveniencia`)), NUMBER);
    expect(explained.last_status_text).toBe(`${ended}. Tiempo de recogida finalizado en Punto de Conveniencia.`);
  });

  it('keeps only the fixed sentences that open an explanation', () => {
    expect(fixedExplanation(' Su envío se encuentra en el punto de conveniencia seleccionado y en breve recibirá las instrucciones para recogerlo.PRIVATE_SYNTHETIC_POINT. 1 PRIVATE_SYNTHETIC_STREET'))
      .toBe('Su envío se encuentra en el punto de conveniencia seleccionado y en breve recibirá las instrucciones para recogerlo.');
    expect(fixedExplanation('Su envío está en uno de nuestros vehí­culos  siendo transportado a la localidad de destino.'))
      .toBe('Su envío está en uno de nuestros vehículos siendo transportado a la localidad de destino.');
    expect(fixedExplanation('. Su envío  no ha podido ser entregado por una incidencia logística en nuestro reparto. Ya hemos gestionado su envío y lo recibirá en la fecha de entrega prevista'))
      .toBe('Su envío no ha podido ser entregado por una incidencia logística en nuestro reparto. Ya hemos gestionado su envío y lo recibirá en la fecha de entrega prevista.');
    for (const text of ['PRIVATE_SYNTHETIC_NOTE. Su envío está entregado.', 'Su envío está entregado a PRIVATE_SYNTHETIC_NAME.',
      'Su envío no ha podido ser entregado por PRIVATE_SYNTHETIC_REASON.', 'SU ENVÍO ESTÁ ENTREGADO.', '']) {
      expect(fixedExplanation(text), text).toBe('');
    }
  });

  it('uses only a matching server-selected no-history outcome, never hidden message text alone', () => {
    expect(() => parseCorreosExpress(negative(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const code of ['', '-1', '1', 'unknown']) expect(() => parseCorreosExpress(negative(NUMBER, code), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosExpress(negative(OTHER), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosExpress(negative().replace('no se ha encontrado ningún envío', 'temporalmente no disponible'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosExpress('<html>Maintenance</html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects incomplete, ambiguous or oversized histories instead of inventing progress', () => {
    expect(() => parseCorreosExpress(edit($ => $('tbody tr').remove()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const changed of [edit($ => $('thead th').first().text('Different column')), edit($ => $('tbody tr').first().find('td').last().remove()),
      edit($ => $('tbody tr').first().find('td').last().text('')),
      edit($ => $('table.miyazaki tbody').html($('table.miyazaki tbody tr').first().toString().repeat(501)))]) {
      expect(() => parseCorreosExpress(changed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('retains label-free and unrecognized native scans without exposing incident details', () => {
    const changed = edit($ => {
      const first = $('tbody tr').first();
      first.find('td').last().text('. PRIVATE_SYNTHETIC_INCIDENT');
      const unknown = first.clone();
      unknown.find('td').first().text('05/01/2026 18:20');
      unknown.find('td').last().text('FIRMADO POR PRIVATE_SYNTHETIC_NAME. Su envío está entregado.');
      first.after(unknown);
      $('tbody tr').eq(2).find('td').last().text('ENTREGADO. PRIVATE_SYNTHETIC_SIGNATURE');
    });
    const result = parseCorreosExpress(changed, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Tracking update', expected_delivery: null });
    expect(result.current_stage).toBeUndefined();
    expect(result.events).toHaveLength(8);
    expect(result.events?.slice(0, 2)).toEqual([
      expect.objectContaining({ description: 'Tracking update', time: '2026-01-05T18:27:00+01:00' }),
      expect.objectContaining({ description: 'Tracking update', time: '2026-01-05T18:20:00+01:00' }),
    ]);
    expect(result.events?.[0]!.provider_status).toBeUndefined();
    expect(result.events?.[1]!.provider_status).toBeUndefined();
    expect(result.events?.[2]).toMatchObject({ description: 'Delivered', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('keeps only the fixed wording of a label-free failed round and reads pickup-point scans', () => {
    const result = normalizeCarrierResult(parseCorreosExpress(failedRound, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-01-16T17:40:00+01:00', delivered_at: '2026-01-16T17:40:00+01:00', expected_delivery: null });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'in_transit', 'failed_attempt',
      'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.[2]!.description).toBe('ENTREGADO EN PUNTO DE CONVENIENCIA. Su envío se encuentra en el punto de conveniencia seleccionado y en breve recibirá las instrucciones para recogerlo.');
    expect(result.events?.[3]).toEqual({ description: FAILED_ROUND, provider_status: FAILED_ROUND, stage: 'failed_attempt',
      time: '2026-01-15T09:45:00+01:00', location: 'VALENCIA' });
    expect(result.events?.[8]!.description).toBe('INFORMADO. Ya hemos recibido la información de su envío, en breve dispondremos de su mercancía.');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const note of ['. Su envío no ha podido ser entregado por PRIVATE_SYNTHETIC_REASON.',
      'Su envío no ha podido ser entregado por PRIVATE_SYNTHETIC_REASON', '. SU ENVIO NO HA PODIDO SER ENTREGADO POR PRIVATE_SYNTHETIC_REASON']) {
      const newest = parseCorreosExpress(edit($ => { $('tbody tr').slice(0, 3).remove(); $('tbody tr').first().find('td').last().text(note); }, failedRound), NUMBER);
      expect(newest).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: FAILED_ROUND, expected_delivery: null });
      expect(JSON.stringify(newest)).not.toContain('PRIVATE_SYNTHETIC');
    }
    // A reason the carrier gives every shipment is kept with the round.
    const reasoned = parseCorreosExpress(edit($ => { $('tbody tr').slice(0, 3).remove(); $('tbody tr').first().find('td').last().text(`. ${EXPLAINED.ADDRESS}`); }, failedRound), NUMBER);
    expect(reasoned).toMatchObject({ current_stage: 'failed_attempt', last_status_text: EXPLAINED.ADDRESS });
    expect(reasoned.events?.[0]!.provider_status).toBe(FAILED_ROUND);
    const waiting = parseCorreosExpress(edit($ => $('tbody tr').first().remove(), failedRound), NUMBER);
    expect(waiting).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup',
      last_status_text: 'DISPONIBLE EN PUNTO DE CONVENIENCIA. Su envío ya está disponible en el punto de conveniencia seleccionado para poder ser recogido.' });
  });

  it('keeps newest unknown or malformed-clock rows ahead of older delivery and preserves unresolved digits', () => {
    for (const clock of ['', '31/02/2026 12:00', '05/01/2026 25:00', '05/01/2026 24:00', 'Tomorrow']) {
      const changed = edit($ => {
        $('tbody tr').first().find('td').eq(0).text(clock);
        $('tbody tr').first().find('td').eq(2).text('NUEVO ESTADO. PRIVATE_SYNTHETIC_DETAIL');
        $('tbody tr').eq(1).find('td').eq(2).text('ENTREGADO. PRIVATE_SYNTHETIC_SIGNATURE');
      });
      for (const result of [parseCorreosExpress(changed, NUMBER), parseCorreosExpress(changed, NUMBER, feed)]) {
        expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Tracking update', last_update: null, expected_delivery: null });
        expect(result.current_stage).toBeUndefined();
        expect(result.delivered_at).toBeUndefined();
        expect(result.events?.[0]!.local_time).toBeUndefined();
        expect(result.events?.[0]!.provider_status).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
        if (clock) expect(result.events?.[0]!.provider_time_text).toBe(clock);
      }
    }
  });

  it('preserves latest terminal semantics and dates a delivery only on a depot\'s clock', () => {
    const terminal = (label: string, place = 'BARCELONA2') => parseCorreosExpress(edit($ => {
      $('tbody tr').first().find('td').eq(1).text(place);
      $('tbody tr').first().find('td').last().text(label + '. PRIVATE_SYNTHETIC_SIGNATURE');
    }), NUMBER);
    expect(terminal('ENTREGADO')).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null,
      last_update: '2026-01-05T18:27:00+01:00', delivered_at: '2026-01-05T18:27:00+01:00' });
    const returned = terminal('DEVUELTO');
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-01-05T18:27:00+01:00' });
    expect(returned.delivered_at).toBeUndefined();
    // A delivery at a place that does not settle its clock keeps its wall clock and gives no instant.
    for (const place of ['TENERIFE', 'MONTIJO', '']) {
      const result = terminal('ENTREGADO', place);
      expect(result, place).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-05T18:27:00' });
      expect(result.delivered_at).toBeUndefined();
    }
    for (const result of [terminal('ENTREGADO'), returned]) expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('keeps provider positions while deduplicating and bounds retained history', () => {
    const deduped = edit($ => {
      const row = $('table.miyazaki tbody tr').first().clone();
      $('table.miyazaki tbody').append(row);
    });
    expect(parseCorreosExpress(deduped, NUMBER).events).toHaveLength(7);
    expect(parseCorreosExpress(deduped, NUMBER).last_status_text).toBe('NUEVO REPARTO');
    const many = edit($ => { const first = $('table.miyazaki tbody tr').first();
      for (let i = 0; i < 105; i++) { const row = first.clone(); row.find('td').eq(1).text('LOCALITY ' + i); $('table.miyazaki tbody').append(row); } });
    expect(parseCorreosExpress(many, NUMBER).events).toHaveLength(100);
  });

  it('validates calendar estimates and omits stale, unresolved and incident promises', () => {
    for (const estimate of ['31 Feb 2026', '03 Ene 2026', '06 Xxx 2026', 'Unknown']) {
      const changed = edit($ => { const heading = $('h3.status');
        heading.contents().filter((_, node) => node.nodeType === 3).remove();
        heading.append('Entrega prevista: Martes, ' + estimate);
      });
      expect(parseCorreosExpress(changed, NUMBER).expected_delivery).toBeNull();
    }
    const incident = edit($ => $('tbody tr').first().find('td').last().text('ESTACIONADO'));
    expect(parseCorreosExpress(incident, NUMBER).expected_delivery).toBeNull();
  });
});

describe('Correos Express scan clocks', () => {
  /** The history with its newest row moved to a place and a wall clock. */
  const newest = (place: string, clock = '05/01/2026 18:27', source = html) => parseCorreosExpress(edit($ => {
    $('tbody tr').first().find('td').eq(0).text(clock);
    $('tbody tr').first().find('td').eq(1).text(place);
  }, source), NUMBER);
  /** The failed round with its admission and the scan in its minute moved to two places. */
  const admitted = (admission: string, beside: string) => parseCorreosExpress(edit($ => {
    $('tbody tr').eq(7).find('td').eq(1).text(admission);
    $('tbody tr').eq(6).find('td').eq(1).text(beside);
  }, failedRound), NUMBER).events!.slice(6, 8);

  it('dates a depot scan on the civil time of the place it is named for', () => {
    for (const [place, clock, time] of [
      ['VALENCIA SUR', '05/01/2026 18:27', '2026-01-05T18:27:00+01:00'],
      ['MADRID CENTRO', '05/01/2026 18:27', '2026-01-05T18:27:00+01:00'],
      ['MADRID GETAFE', '05/07/2026 18:27', '2026-07-05T18:27:00+02:00'],
      ['DOS HERMANAS - SEVILLA', '05/01/2026 18:27', '2026-01-05T18:27:00+01:00'],
      ['Málaga', '05/07/2026 18:27', '2026-07-05T18:27:00+02:00'],
      ['PALMA DE MALLORCA', '05/01/2026 18:27', '2026-01-05T18:27:00+01:00'],
      ['MELILLA', '05/01/2026 18:27', '2026-01-05T18:27:00+01:00'],
      ['ALGECIRAS', '05/07/2026 18:27', '2026-07-05T18:27:00+02:00'],
      ['PORTO', '05/01/2026 18:27', '2026-01-05T18:27:00+00:00'],
      ['LISBOA2', '05/07/2026 18:27', '2026-07-05T18:27:00+01:00'],
    ] as const) {
      const result = newest(place, clock);
      expect(result.events?.[0], place).toMatchObject({ time, location: place });
      expect(result.events?.[0]!.local_time).toBeUndefined();
      expect(result.last_update, place).toBe(time);
      expect(result.last_update_local).toBeUndefined();
    }
  });

  it('keeps the wall clock of a scan whose place does not settle its zone, and then reports no instant', () => {
    // The Canary Islands and the Azores keep other clocks; Montijo and Vila Real are towns of Spain and of Portugal.
    for (const place of ['TENERIFE', 'LAS PALMAS', 'LA PALMA', 'ARRECIFE - LAS PALMAS', 'TELDE - MADRID', 'SANTA CRUZ DE TENERIFE', 'PONTA DELGADA',
      'MONTIJO', 'VILA REAL', 'LOCALIDAD SINTETICA', 'SANT BOI DE LLOBREGAT', '']) {
      const result = newest(place);
      expect(result.events?.[0], place).toMatchObject({ local_time: '2026-01-05T18:27:00' });
      expect(result.events?.[0]!.time).toBeUndefined();
      expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-05T18:27:00' });
      // The depots before it keep their own clock.
      expect(result.events?.[1], place).toMatchObject({ time: '2026-01-02T10:01:00+01:00', location: 'BARCELONA2' });
    }
  });

  it('skips a wall clock its zone skips and reads a repeated one as its first occurrence', () => {
    expect(newest('MADRID', '29/03/2026 02:30').events?.[0]).toMatchObject({ local_time: '2026-03-29T02:30:00' });
    expect(newest('PORTO', '29/03/2026 01:30').events?.[0]).toMatchObject({ local_time: '2026-03-29T01:30:00' });
    expect(newest('MADRID', '29/03/2026 03:30').events?.[0]).toMatchObject({ time: '2026-03-29T03:30:00+02:00' });
    expect(newest('MADRID', '25/10/2026 02:30').events?.[0]).toMatchObject({ time: '2026-10-25T02:30:00+02:00' });
    expect(newest('PORTO', '25/10/2026 01:30').events?.[0]).toMatchObject({ time: '2026-10-25T01:30:00+01:00' });
  });

  it('dates the scans of an admission minute only when all their places keep one clock', () => {
    const at = (time: string) => [{ time, location: expect.any(String) }, { time, location: expect.any(String) }];
    expect(admitted('MADRID', 'MADRID')).toMatchObject(at('2026-01-14T15:10:00+01:00'));
    expect(admitted('DOS HERMANAS - SEVILLA', 'BARCELONA2')).toMatchObject(at('2026-01-14T15:10:00+01:00'));
    expect(admitted('PORTO', 'LISBOA')).toMatchObject(at('2026-01-14T15:10:00+00:00'));
    // The sender's town need not name the admitting depot, nor the hub beside it share its clock.
    for (const [admission, beside] of [['SANT BOI DE LLOBREGAT', 'MADRID'], ['OVIEDO', 'PORTO'], ['LAS PALMAS', 'MADRID'], ['', 'MADRID']]) {
      const pair = admitted(admission!, beside!);
      expect(pair.map(event => event.local_time), admission).toEqual(['2026-01-14T15:10:00', '2026-01-14T15:10:00']);
      expect(pair.every(event => !event.time)).toBe(true);
    }
    // A scan in another minute keeps its own place's clock.
    const later = parseCorreosExpress(edit($ => $('tbody tr').eq(7).find('td').eq(1).text('SANT BOI DE LLOBREGAT'), failedRound), NUMBER);
    expect(later.events?.[5]).toMatchObject({ time: '2026-01-15T07:02:00+01:00', location: 'VALENCIA' });
  });

  it('dates the head office scans only when every depot of the parcel keeps Madrid\'s clock', () => {
    expect(newest('BARCELONA2').events?.[6]).toMatchObject({ time: '2025-12-30T13:15:00+01:00', location: 'CENTRAL' });
    // An admission names the sender's town and does not decide it.
    const sender = parseCorreosExpress(edit($ => $('tbody tr').eq(5).find('td').eq(1).text('LOCALIDAD SINTETICA')), NUMBER);
    expect(sender.events?.[6]).toMatchObject({ time: '2025-12-30T13:15:00+01:00' });
    for (const place of ['PORTO', 'TENERIFE', 'LOCALIDAD SINTETICA']) {
      const result = newest(place);
      expect(result.events?.[6], place).toMatchObject({ local_time: '2025-12-30T13:15:00', location: 'CENTRAL' });
      expect(result.events?.[6]!.time).toBeUndefined();
    }
  });

  it('dates a delivery from its depot\'s clock and leaves it undated otherwise', () => {
    expect(newest('PORTO', '16/01/2026 17:40', failedRound)).toMatchObject({ status: 'delivered',
      last_update: '2026-01-16T17:40:00+00:00', delivered_at: '2026-01-16T17:40:00+00:00' });
    const canary = newest('TENERIFE', '16/01/2026 17:40', failedRound);
    expect(canary).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-16T17:40:00' });
    expect(canary.delivered_at).toBeUndefined();
    expect(canary.events?.[1]).toMatchObject({ time: '2026-01-15T12:21:00+01:00' });
  });
});

describe('Correos Express history from the Correos localizador', () => {
  it('gives the form scans situation codes, fixed explanations and, while they keep their wall clock, seconds', () => {
    const result = normalizeCarrierResult(parseCorreosExpress(explained, NUMBER, feed));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-01-05T18:27:00+01:00',
      last_status_text: 'NUEVO REPARTO. Concertación entrega flexible.', expected_delivery: '2026-01-06' });
    expect(result.events?.map(({ time, local_time, provider_code, location }) => [time ?? local_time, provider_code, location])).toEqual([
      ['2026-01-05T18:27:00+01:00', 'X110430V', 'BARCELONA2'],
      // A coded scan in a minute the form does not show, which has no locality and so keeps its wall clock.
      ['2026-01-03T08:30:12', 'X060000V', undefined],
      ['2026-01-02T10:01:00+01:00', 'X100010R', 'BARCELONA2'],
      ['2026-01-02T09:00:00+01:00', 'X080000V', 'BARCELONA2'],
      ['2026-01-01T12:00:00+01:00', 'X060000V', 'MADRID'],
      ['2026-01-01T06:03:00+01:00', 'X020000V', 'MADRID'],
      // The localizador has no admission; the uncoded scan in its minute is not paired with it.
      ['2025-12-31T13:15:00+01:00', undefined, 'OVIEDO'],
      ['2025-12-30T13:15:00+01:00', 'X010000V', 'CENTRAL'],
    ]);
    expect(result.events?.filter(event => event.local_time).map(event => event.location)).toEqual([undefined]);
    // Scans that keep their wall clock take the localizador's seconds.
    const undated = parseCorreosExpress(edit($ => $('tbody tr').find('td:nth-child(2)').text('LOCALIDAD SINTETICA'), explained), NUMBER, feed);
    expect(undated).toMatchObject({ last_update: null, last_update_local: '2026-01-05T18:27:05' });
    expect(undated.events?.map(event => event.local_time)).toEqual(['2026-01-05T18:27:05', '2026-01-03T08:30:12', '2026-01-02T10:01:33',
      '2026-01-02T09:00:18', '2026-01-01T12:00:51', '2026-01-01T06:03:27', '2025-12-31T13:15:00', '2025-12-30T13:15:42']);
    expect(undated.events?.every(event => !event.time)).toBe(true);
    expect(result.events?.map(event => event.description)).toEqual(['NUEVO REPARTO. Concertación entrega flexible.',
      `EN DESTINO. ${EXPLAINED.EN_DESTINO}`, `EN ALMACÉN. ${EXPLAINED.ADDRESS}`, `EN REPARTO. ${EXPLAINED.EN_REPARTO}`,
      `EN DESTINO. ${EXPLAINED.EN_DESTINO}`, `EN RUTA A LOCALIDAD DE DESTINO. ${EXPLAINED.EN_RUTA}`, 'ADMITIDO', `INFORMADO. ${EXPLAINED.INFORMADO}`]);
    expect(resultTimezone('correos-express', result)).toBe('Europe/Madrid');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('dates a form row to the minute it shows, whether or not the localizador answers', () => {
    const dated = (result: ReturnType<typeof parseCorreosExpress>) => result.events?.filter(event => event.time)
      .map(({ time, location, stage }) => [time, location, stage]);
    for (const source of [explained, html, failedRound]) {
      const alone = parseCorreosExpress(source, NUMBER);
      const enriched = parseCorreosExpress(source, NUMBER, feed);
      expect(dated(alone)!.length).toBeGreaterThan(0);
      expect(dated(enriched)).toEqual(dated(alone));
      expect(enriched.last_update).toBe(alone.last_update);
      expect(enriched.delivered_at).toBe(alone.delivered_at);
    }
    expect(dated(parseCorreosExpress(explained, NUMBER, feed))!.every(([time]) => /T\d{2}:\d{2}:00[+-]/.test(String(time)))).toBe(true);
  });

  it('pairs an uncoded scan only with the one row left in its minute, and a coded one only with its situation', () => {
    const uncoded = (time: string) => ({ local_time: time, explanation: '' });
    // Rows that keep their wall clock show which localizador scan, if any, gave them its seconds.
    const undated = edit($ => $('tbody tr').find('td:nth-child(2)').text('LOCALIDAD SINTETICA'));
    const scans = (list: CorreosExpressFeed['scans']) => parseCorreosExpress(undated, NUMBER, { shipment: NUMBER, scans: list }).events!;
    expect(scans([uncoded('2026-01-01T12:00:40')])[3]).toMatchObject({ local_time: '2026-01-01T12:00:40', description: 'EN DESTINO' });
    expect(scans([uncoded('2026-01-01T12:00:40')])[3]!.provider_code).toBeUndefined();
    // Two uncoded scans for one row, or a coded scan of another situation, leave the row to the minute.
    expect(scans([uncoded('2026-01-01T12:00:40'), uncoded('2026-01-01T12:00:45')])[3]!.local_time).toBe('2026-01-01T12:00:00');
    const other = scans([{ local_time: '2026-01-01T12:00:40', code: 'X080000V', explanation: '' }]);
    expect(other[3]).toMatchObject({ local_time: '2026-01-01T12:00:00', description: 'EN DESTINO' });
    expect(other).toHaveLength(7);
    // A failed round in the localizador is the form's label-free note.
    const failed = parseCorreosExpress(failedRound, NUMBER, { shipment: NUMBER, scans: [
      { local_time: '2026-01-15T09:45:31', code: 'X090060R', explanation: 'Su envío no ha podido ser entregado por no localizar al destinatario en el momento de la entrega.' }] });
    expect(failed.events?.[3]).toMatchObject({ time: '2026-01-15T09:45:00+01:00', provider_code: 'X090060R', stage: 'failed_attempt',
      description: 'Su envío no ha podido ser entregado por no localizar al destinatario en el momento de la entrega.' });
    // A localizador history of another shipment is not used.
    expect(parseCorreosExpress(html, NUMBER, { ...feed, shipment: OTHER }).events?.every(event => !event.provider_code)).toBe(true);
  });

  it('reads the localizador reply only for the whole number or a label of the shipment it names', () => {
    expect(feed.shipment).toBe(NUMBER);
    expect(feed.scans).toHaveLength(9);
    expect(JSON.stringify(feed)).not.toContain('PRIVATE_SYNTHETIC');
    expect(parseCorreosExpressFeed(noTrace(), NUMBER)).toBeNull();
    expect(parseCorreosExpressFeed(noTrace()[0], NUMBER)).toBeNull();
    const labelled = feedPayload((envelope) => { envelope.codEnvio = SHIPMENT; });
    expect(parseCorreosExpressFeed(labelled, LABEL)?.shipment).toBe(SHIPMENT);
    expect(parseCorreosExpressFeed(noTrace(LABEL), LABEL)).toBeNull();
    for (const [payload, number] of [[feedPayload(), OTHER], [noTrace(OTHER), NUMBER], [labelled, '99000000000000002999993'],
      [feedPayload((envelope) => { envelope.enviosAsociados = []; envelope.codEnvio = SHIPMENT; }), LABEL], [feedPayload(), LABEL],
      [[], NUMBER], [[...feedPayload(), ...feedPayload()], NUMBER], ['<html>Blocked</html>', NUMBER]] as const) {
      expect(() => parseCorreosExpressFeed(payload, number)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [(envelope: Envelope) => { envelope.eventos = {} as never; },
      (envelope: Envelope) => { envelope.eventos![0]!.horEvento = '24:00:00'; },
      (envelope: Envelope) => { envelope.eventos![0]!.fecEvento = '31/02/2026'; },
      (envelope: Envelope) => { envelope.eventos![0]!.codEvento = 'X01 PRIVATE'; },
      (envelope: Envelope) => { envelope.eventos = Array.from({ length: 501 }, () => envelope.eventos![0]!); }]) {
      expect(() => parseCorreosExpressFeed(feedPayload(change), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const code of ['1', '', undefined]) {
      expect(() => parseCorreosExpressFeed(feedPayload((envelope) => { envelope.error = { codError: code }; }), NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('answers from the localizador alone only with Correos Express situation codes', () => {
    const result = normalizeCarrierResult(correosExpressFeedResult(feed, NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_status_text: 'NUEVO REPARTO. Concertación entrega flexible.', last_update_local: '2026-01-05T18:27:05', expected_delivery: null });
    expect(result.events?.map(({ local_time, description }) => [local_time, description])).toEqual([
      ['2026-01-05T18:27:05', 'NUEVO REPARTO. Concertación entrega flexible.'],
      ['2026-01-03T08:30:12', `EN DESTINO. ${EXPLAINED.EN_DESTINO}`],
      ['2026-01-02T10:01:33', `EN ALMACÉN. ${EXPLAINED.ADDRESS}`],
      ['2026-01-02T09:00:18', `EN REPARTO. ${EXPLAINED.EN_REPARTO}`],
      ['2026-01-01T12:00:58', 'Tracking update'],
      ['2026-01-01T12:00:51', `EN DESTINO. ${EXPLAINED.EN_DESTINO}`],
      ['2026-01-01T06:03:27', `EN RUTA A LOCALIDAD DE DESTINO. ${EXPLAINED.EN_RUTA}`],
      ['2025-12-31T13:15:09', 'Tracking update'],
      ['2025-12-30T13:15:42', 'INFORMADO. Ya hemos recibido la información de su envío, en breve dispondremos de su mercancía. Si necesita más información por favor contacte con su remitente.'],
    ]);
    expect(result.events?.every(event => !event.time && !event.location)).toBe(true);
    expect(correosExpressFeedResult({ ...feed, shipment: SHIPMENT }, LABEL).canonical_tracking_number).toBe(SHIPMENT);
    // The localizador serves the whole Correos group: a history without Correos Express codes is not taken.
    for (const scans of [[{ local_time: '2026-01-01T10:00:00', code: 'A010000V', explanation: '' }, ...feed.scans],
      feed.scans.map(({ local_time }) => ({ local_time, explanation: '' })), []]) {
      expect(() => correosExpressFeedResult({ shipment: NUMBER, scans }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });
});

describe('Correos Express retrieval', () => {
  it('sends one anonymous form POST and one localizador read, with no bootstrap, cookie, authorization or credential', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      if (String(url) === FORM) {
        expect(init).toMatchObject({ method: 'POST' });
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        expect(String(init?.body)).toBe('shippingNumber=' + NUMBER + '&errorCode=');
        return response();
      }
      expect(String(url)).toBe(`${FEED}${NUMBER}?codAplicacion=60&codCanal=3&codIdioma=ES&indUltEvento=N`);
      expect(init?.method ?? 'GET').toBe('GET');
      return json(feedPayload());
    }) as unknown as typeof fetch;
    const instance = adapter(environment(fetcher));
    const result = await instance.track({ number: NUMBER, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' });
    expect(result).toMatchObject({ status: 'in_transit', last_update: '2026-01-05T18:27:00+01:00' });
    expect(result.events).toHaveLength(8);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the form history when the localizador fails or answers for another shipment', async () => {
    for (const localizador of [() => new Response('Unavailable', { status: 503 }), () => response('<html>Blocked</html>'),
      () => json(feedPayload((envelope) => { envelope.codEnvio = OTHER; })), () => json(noTrace()),
      () => Promise.reject(new TypeError('network'))]) {
      const result = await new CorreosExpressTracker({ fetcher: routed(() => response(), localizador) }).fetch(NUMBER);
      expect(result).toMatchObject({ status: 'in_transit', last_update: '2026-01-05T18:27:00+01:00' });
      expect(result.events?.every(event => !event.provider_code)).toBe(true);
    }
  });

  it('confirms the form negative only when the localizador has no trace either', async () => {
    const tracker = (localizador: () => Response | Promise<Response>) => new CorreosExpressTracker({ fetcher: routed(() => response(negative()), localizador) });
    await expect(tracker(() => json(noTrace())).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    // The form forgets a shipment after a while; the localizador may still hold its history.
    expect(await tracker(() => json(feedPayload())).fetch(NUMBER)).toMatchObject({ status: 'in_transit', last_update_local: '2026-01-05T18:27:05' });
    for (const [localizador, kind] of [[() => new Response('Busy', { status: 429 }), 'rate_limited'], [() => new Response('Denied', { status: 403 }), 'challenge'],
      [() => response('<html>Blocked</html>'), 'schema'], [() => json(feedPayload((envelope) => { envelope.codEnvio = OTHER; })), 'schema'],
      [() => json(feedPayload((envelope) => { envelope.error = { codError: '1' }; })), 'indeterminate'],
      [() => Promise.reject(new TypeError('network')), 'transport'],
      [() => json(feedPayload((envelope) => { envelope.eventos![0]!.codEvento = 'A010000V'; })), 'indeterminate']] as const) {
      await expect(tracker(localizador).fetch(NUMBER)).rejects.toMatchObject({ kind });
    }
  });

  it('answers from the localizador when the form fails, and keeps the form failure when it cannot', async () => {
    const steps: StepRecord[] = [];
    const recorder = { step: (step: StepRecord) => steps.push(step), lookup() {} };
    const blocked = () => new Response('Denied', { status: 403 });
    const recovered = await new CorreosExpressTracker({ fetcher: routed(blocked, () => json(feedPayload())), recorder }).fetch(NUMBER);
    expect(recovered).toMatchObject({ status: 'in_transit', last_status_text: 'NUEVO REPARTO. Concertación entrega flexible.' });
    expect(steps.map(({ step, outcome, fallbackFrom, fallbackReason }) => [step, outcome, fallbackFrom, fallbackReason]))
      .toEqual([['direct', 'challenge', null, null], ['correos', 'ok', 'direct', 'challenge']]);
    for (const [form, kind] of [[blocked, 'challenge'], [() => new Response('Busy', { status: 429 }), 'rate_limited'],
      [() => response('<html>Maintenance</html>'), 'indeterminate'], [() => response(edit($ => $('thead th').first().text('Changed'))), 'schema']] as const) {
      for (const localizador of [() => json(noTrace()), () => new Response('Unavailable', { status: 503 }), () => response('<html>Blocked</html>')]) {
        await expect(new CorreosExpressTracker({ fetcher: routed(form, localizador) }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      }
      expect(await new CorreosExpressTracker({ fetcher: routed(form, () => json(feedPayload())) }).fetch(NUMBER)).toMatchObject({ status: 'in_transit' });
    }
  });

  it('recognizes matching history and a confirmed negative, ranks only dated scans and never converts failure to absence', async () => {
    const fetcher = routed(() => response());
    const instance = adapter(environment(fetcher));
    expect(await instance.recognize!('invalid')).toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-01-05T17:27:00.000Z' });
    // The localizador's history alone has no localities, so no instant ranks it.
    expect(await adapter(environment(routed(() => response(negative())))).recognize!(NUMBER)).toEqual({ known: false });
    expect(await adapter(environment(routed(() => response(negative()), () => json(feedPayload())))).recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-05T18:27:05' });
    await expect(adapter(environment(routed(() => response(negative(NUMBER, '-1'))))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(adapter(environment(routed(() => response(negative()), () => new Response('Busy', { status: 429 })))).recognize!(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('preserves generic HTTP failures and streaming body limits without retrying', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn(async () => new Response('Unavailable', { status })) as unknown as typeof fetch;
      await expect(new CorreosExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(urls(fetcher).filter(url => url === FORM)).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const large = vi.fn(async () => new Response(new Uint8Array(1_000_001))) as unknown as typeof fetch;
    await expect(new CorreosExpressTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    expect(large).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before and during retrieval and enforces the whole lookup budget', async () => {
    const immediate = routed(() => response());
    await expect(new CorreosExpressTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new CorreosExpressTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const waiting = vi.fn(async (_url, init) => {
      init?.signal?.throwIfAborted();
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      return response();
    }) as unknown as typeof fetch;
    const active = new CorreosExpressTracker({ fetcher: waiting }).fetch(NUMBER, { signal: controller.signal });
    controller.abort();
    await expect(active).rejects.toMatchObject({ kind: 'transport' });
    expect(waiting).toHaveBeenCalledTimes(2);
    // The form's own timeout and the budget end together: the form's failure stands unless no
    // time is left for the localizador's step, so either is the answer.
    const spent = await new CorreosExpressTracker({ fetcher: waiting }).fetch(NUMBER, { budgetMs: 20 }).catch((error: unknown) => error);
    expect(['budget', 'transport']).toContain(carrierErrorKind(spent));
    expect(waiting).toHaveBeenCalledTimes(4);
  });
});

describe('Correos Express in Portuguese', () => {
  const FAILED_ROUND_PT = 'Não foi possivel entregar o seu envio';
  /** A localizador reply in Portuguese for the failed round's history: two scans the form shows and two it does not. */
  const portugueseFeed = parseCorreosExpressFeed(feedPayload((envelope) => {
    envelope.eventos = [
      { fecEvento: '15/01/2026', horEvento: '07:02:31', codEvento: 'X060000V',
        desTextoAmpliado: 'O seu envio está nas nossas instalações de destino e estamos a classificá-lo. Recebê-lo-á na data de entrega prevista.' },
      { fecEvento: '15/01/2026', horEvento: '09:45:12', codEvento: 'X090060R',
        desTextoAmpliado: 'O seu envio  não pôde ser entregue porque o destinatário não foi encontrado no momento da entrega. Se deseja gerir uma nova entrega por favor prima a opção Gerir nova entrega.' },
      { fecEvento: '15/01/2026', horEvento: '10:30:00', codEvento: 'X140000V', desTextoAmpliado: 'PRIVATE_SYNTHETIC_NOTE' },
      { fecEvento: '15/01/2026', horEvento: '11:00:05', codEvento: 'X080000V',
        desTextoAmpliado: 'O seu envio encontra-se em distribuição. Recebê-lo-á na data de entrega prevista.PRIVATE_SYNTHETIC_NOTE' },
    ];
  }), NUMBER)!;
  const NOT_DELIVERED = 'O seu envio não pôde ser entregue porque o destinatário não foi encontrado no momento da entrega. Se deseja gerir uma nova entrega por favor prima a opção Gerir nova entrega.';
  const IN_DELIVERY = 'EM DISTRIBUIÇÃO. O seu envio encontra-se em distribuição. Recebê-lo-á na data de entrega prevista.';

  it('reads the Portuguese page as the Spanish one: the same clocks, places and stages, worded in Portuguese', () => {
    const spanish = normalizeCarrierResult(parseCorreosExpress(failedRound, NUMBER));
    const result = normalizeCarrierResult(parseCorreosExpress(portuguese, NUMBER));
    const facts = (read: typeof result) => read.events?.map(({ time, local_time, location, stage }) => [time ?? local_time, location, stage]);
    expect(facts(result)).toEqual(facts(spanish));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: spanish.last_update, delivered_at: spanish.delivered_at, expected_delivery: null });
    expect(result.events?.map(event => event.description)).toEqual(['Delivered',
      'DISPONÍVEL EM PONTO DE CONVENIÊNCIA. Sua remessa já está disponível no ponto de conveniência selecionado para retirada.',
      // The Portuguese form runs the pickup point's name straight on from the sentence.
      'ENTREGUE EM PONTO DE CONVENIÊNCIA. Sua remessa está no ponto de conveniência selecionado e em breve você receberá instruções para retirá-la.',
      FAILED_ROUND_PT,
      'EM DISTRIBUIÇÃO. Seu envio encontra-se em distribuição. Será entregue na data prevista.',
      'NO DESTINO. Seu envio está nas nossas instalações de destino e estamos a classificá-lo. Será entregue na data prevista.',
      'EM TRANSITO PARA A LOCALIDADE DE DESTINO. Seu envio está em trânsito para a localidade destino nos nossos veículos. Será entregue na data prevista.',
      'ADMITIDO',
      'INFORMADO. Já recebemos as informações do seu envio, em breve teremos a sua mercadoria na nossa posse.']);
    expect(result.events?.[3]).toMatchObject({ provider_status: FAILED_ROUND_PT, stage: 'failed_attempt' });
    // Each description reads back to its scan's stage as the app keys it.
    for (const { description, stage } of result.events!) expect(statusMap.stage(null, normalizeStatusWording(description!)), description).toBe(stage);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const [label, status, stage] of [['A SER GERENCIADO', 'exception', 'exception'], ['DEVOLVIDO', 'exception', 'returned'],
      ['EM ARMAZÉM', 'exception', 'exception'], ['EM REDISTRIBUIÇÃO', 'in_transit', 'in_transit'],
      ['O PRAZO PARA RETIRADA DA REMESSA NO PONTO DE CONVENIÊNCIA SELECIONADO TERMINOU E ELA SERÁ DEVOLVIDA À SUA ORIGEM', 'exception', 'returned']] as const) {
      const newest = parseCorreosExpress(edit($ => $('tbody tr').first().find('td').last().text(`${label}. PRIVATE_SYNTHETIC_NOTE`), portuguese), NUMBER);
      expect(newest, label).toMatchObject({ status, current_stage: stage, last_status_text: label });
    }
    const negativePt = negative().replace('Lo sentimos, no se ha encontrado ningún envío con el número indicado.',
      'Desculpe, não foi encontrado nenhum envio com o número indicado.');
    expect(() => parseCorreosExpress(negativePt, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });

  it('labels the Portuguese localizador\'s scans as the Portuguese page does, and a situation it has not shown in Spanish', () => {
    for (const situation of ['01', '02', '04', '06', '08', '09', '10', '11', '12', '13', '17', '38', '39']) {
      const label = correosExpressCodeLabel(`X${situation}0000V`, 'pt')!;
      expect(classifyCorreosExpressStatus(label), situation).toEqual(classifyCorreosExpressStatus(correosExpressCodeLabel(`X${situation}0000V`)!));
    }
    expect(correosExpressCodeLabel('X140000V', 'pt')).toBe('CAMBIO DE DESTINO');
    const result = normalizeCarrierResult(parseCorreosExpress(portuguese, NUMBER, portugueseFeed));
    expect(result.events?.slice(3, 7).map(({ time, local_time, provider_code, stage, description }) => [time ?? local_time, provider_code, stage, description])).toEqual([
      ['2026-01-15T11:00:05', 'X080000V', 'out_for_delivery', IN_DELIVERY],
      ['2026-01-15T10:30:00', 'X140000V', 'in_transit', 'CAMBIO DE DESTINO'],
      // The localizador gives the round its fixed reason, which the form's note left out.
      ['2026-01-15T09:45:00+01:00', 'X090060R', 'failed_attempt', NOT_DELIVERED],
      ['2026-01-15T07:30:00+01:00', undefined, 'out_for_delivery', 'EM DISTRIBUIÇÃO. Seu envio encontra-se em distribuição. Será entregue na data prevista.'],
    ]);
    expect(result.events?.[7]).toMatchObject({ provider_code: 'X060000V', description: expect.stringMatching(/^NO DESTINO\. Seu envio/) });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    const alone = normalizeCarrierResult(correosExpressFeedResult(portugueseFeed, NUMBER, 'pt'));
    expect(alone).toMatchObject({ status: 'out_for_delivery', last_status_text: IN_DELIVERY });
    expect(alone.events?.map(event => event.description)).toEqual([IN_DELIVERY, 'CAMBIO DE DESTINO', NOT_DELIVERED,
      'NO DESTINO. O seu envio está nas nossas instalações de destino e estamos a classificá-lo. Recebê-lo-á na data de entrega prevista.']);
    expect(statusMap.stage(null, normalizeStatusWording(NOT_DELIVERED))).toBe('failed_attempt');
  });

  it('lets a scan stored in one language take the other\'s wording in place, at the same place and situation', () => {
    const policy = sameInstantIdentityPolicy('correos-express', { supportsScanMatching: true })!;
    const scan = (description: string, stage: string, location = 'VALENCIA') => ({ description, stage, location, providerCode: '' });
    for (const [spanish, translated, stage] of [
      [`EN DESTINO. ${EXPLAINED.EN_DESTINO}`, 'NO DESTINO. Seu envio está nas nossas instalações de destino e estamos a classificá-lo. Será entregue na data prevista.', 'in_transit'],
      ['EN REPARTO', 'EM DISTRIBUIÇÃO', 'out_for_delivery'],
      [EXPLAINED.ADDRESS, 'Não foi possivel entregar o seu envio porque a morada de destino está incompleta ou incorreta.', 'failed_attempt'],
      [FAILED_ROUND, NOT_DELIVERED, 'failed_attempt'],
      ['ENTREGADO EN PUNTO DE CONVENIENCIA', 'ENTREGUE EM PONTO DE CONVENIÊNCIA', 'in_transit'],
      ['NUEVO REPARTO. Concertación entrega flexible.', 'EM REDISTRIBUIÇÃO. Acordo entrega flexível.', 'in_transit'],
    ] as const) {
      expect(policy.matches!(scan(translated, stage), scan(spanish, stage)), translated).toBe(true);
      expect(policy.matches!(scan(spanish, stage), scan(translated, stage)), spanish).toBe(true);
    }
    // Another situation or another place is another scan, and an unread label takes over nothing.
    expect(policy.matches!(scan('EM DISTRIBUIÇÃO', 'out_for_delivery'), scan('EN DESTINO', 'in_transit'))).toBe(false);
    expect(policy.matches!(scan('EM DISTRIBUIÇÃO', 'out_for_delivery'), scan('EN REPARTO', 'out_for_delivery', 'MADRID'))).toBe(false);
    expect(policy.matches!(scan('Tracking update', ''), scan('EN REPARTO', 'out_for_delivery'))).toBe(false);
  });

  it('asks the form and the localizador in Portuguese for a Portuguese reader, and in Spanish for anyone else', async () => {
    for (const [language, form, idioma] of [['pt', FORM_PT, 'PT'], ['pt-BR', FORM_PT, 'PT'], ['es-ES', FORM, 'ES'], ['ca', FORM, 'ES'],
      ['en', FORM, 'ES'], [null, FORM, 'ES']] as const) {
      const fetcher = routed(() => response(form === FORM_PT ? portuguese : failedRound));
      const result = await adapter(environment(fetcher)).track({ number: NUMBER, language });
      expect(urls(fetcher).sort(), String(language)).toEqual([form, `${FEED}${NUMBER}?codAplicacion=60&codCanal=3&codIdioma=${idioma}&indUltEvento=N`].sort());
      expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-01-16T17:40:00+01:00' });
    }
  });

  it('asks again in Spanish when the Portuguese page shows a label the map does not read, and keeps the Portuguese when that fails', async () => {
    const unread = edit($ => $('tbody tr').eq(1).find('td').last().text('ESTADO SINTÉTICO. PRIVATE_SYNTHETIC_NOTE'), portuguese);
    const answering = (page: string, spanish: () => Response) => vi.fn(async (url: string | URL | Request) => (String(url) === FORM_PT ? response(page)
      : String(url) === FORM ? spanish() : json(noTrace()))) as unknown as typeof fetch;
    const asked = answering(unread, () => response(failedRound));
    const result = await adapter(environment(asked)).track({ number: NUMBER, language: 'pt' });
    expect(result.events?.[1]).toMatchObject({ provider_status: 'DISPONIBLE EN PUNTO DE CONVENIENCIA', stage: 'ready_for_pickup' });
    expect(urls(asked).filter(url => !url.startsWith(FEED))).toEqual([FORM_PT, FORM]);
    expect(urls(asked).filter(url => url.startsWith(FEED)).map(url => new URL(url).searchParams.get('codIdioma'))).toEqual(['PT', 'ES']);
    const kept = await adapter(environment(answering(unread, () => new Response('Unavailable', { status: 503 })))).track({ number: NUMBER, language: 'pt' });
    expect(kept.events?.map(event => event.description).slice(0, 3)).toEqual(['Delivered', 'Tracking update',
      'ENTREGUE EM PONTO DE CONVENIÊNCIA. Sua remessa está no ponto de conveniência selecionado e em breve você receberá instruções para retirá-la.']);
    // A note without a label reads no better in Spanish, so it is not asked again.
    const note = answering(edit($ => $('tbody tr').eq(1).find('td').last().text('. PRIVATE_SYNTHETIC_INCIDENT'), portuguese), () => response(failedRound));
    expect((await adapter(environment(note)).track({ number: NUMBER, language: 'pt' })).events?.[1]).toMatchObject({ description: 'Tracking update' });
    expect(urls(note).filter(url => !url.startsWith(FEED))).toEqual([FORM_PT]);
  });
});
