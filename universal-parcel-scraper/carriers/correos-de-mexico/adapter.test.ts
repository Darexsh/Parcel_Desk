import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CorreosDeMexicoTracker } from './adapter.js';
import {
  CORREOS_DE_MEXICO_ORIGIN, CORREOS_DE_MEXICO_PAGE, correosDeMexicoLookupUrl, correosDeMexicoResult, readCorreosDeMexicoPage,
  type CorreosDeMexicoScan,
} from './parser.js';
import { correosDeMexicoScanStage, correosDeMexicoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KNOWN = 'ZZ000000014MX';
const OTHER = 'ZZ000000028MX';
const SPLIT = 'ZZ000000031MX';
const INBOUND = 'ZZ000000014JP';
const ABSENT = 'ZZ900000005MX';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, status = 302) => new Response('', { status, headers: { location } });
/** The page as the form's postback returns it for another year: that year selected, the form posting to the bare page, new state. */
const forYear = (body: string, year: string) => body
  .replace(' selected="selected"', '')
  .replace(`<option value="${year}">`, `<option selected="selected" value="${year}">`)
  .replace(/action="\.\/Seguimiento\.aspx\?guia=[A-Z0-9]+"/, 'action="./Seguimiento.aspx"')
  .replaceAll(/Synthetic(ViewState|EventValidation)(\w+)/g, `Synthetic$1$2${year}`);
const missing = (number: string, year = '2026') => {
  const notice = page('not-found').replaceAll(ABSENT, number);
  return year === '2026' ? notice : forYear(notice, year);
};
/** A page with one more scan after its last, and its count updated. */
const withRow = (body: string, [day, clock, place, wording]: readonly string[]) => {
  const total = Number(/Total de eventos : (\d+)/.exec(body)![1]);
  return body.replace(/(\t\t<\/tr>\n\t<\/table>)/, `\t\t</tr><tr>\n\t\t\t<td>${day}</td><td>${clock}</td><td>${place}</td><td>${wording}</td><td>${total + 1}</td>\n$1`)
    .replace(`Total de eventos : ${total}`, `Total de eventos : ${total + 1}`);
};
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof correosDeMexicoResult>) =>
  result.events!.map(event => [event.time ?? `local ${String(event.local_time)}`, event.description, event.location, event.stage]);
const read = (name: string, number: string) => {
  const found = readCorreosDeMexicoPage(page(name), number);
  return correosDeMexicoResult(found.scans!, number);
};
const failure = (run: () => unknown) => {
  try { run(); }
  catch (error) { return error as { kind?: string; reason?: string; message?: string }; }
  throw new Error('no failure');
};
const requests = (fetcher: ReturnType<typeof site>) => fetcher.mock.calls.map(([url, init]) => {
  const body = new URLSearchParams(String(init?.body ?? ''));
  return `${init?.method} ${String(url)}${body.has('Periodo') ? ` ${body.get('Periodo')}` : ''}`;
});

type Answer = string | Response | (() => Response | Promise<Response>);

/** The tracking page: its own address answers for the current year, its form's postback for the year posted. */
function site(pages: Record<string, Record<string, Answer>> = {}) {
  const known: Record<string, Record<string, Answer>> = {
    [KNOWN]: { 2026: page('delivered') }, [OTHER]: { 2026: page('abroad') }, [INBOUND]: { 2026: page('inbound') },
    [SPLIT]: { 2026: page('split-2026'), 2025: page('split-2025') }, ...pages,
  };
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const posted = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : null;
    const number = posted ? posted.get('Guia')! : url.searchParams.get('guia')!;
    const year = posted ? posted.get('Periodo')! : '2026';
    const answer = known[number]?.[year] ?? missing(number, year);
    const value = typeof answer === 'function' ? await answer() : answer;
    return typeof value === 'string' ? html(value) : value;
  });
}

describe('Correos de México tracking adapter', () => {
  it('opens the page’s own address for the number, which answers for the current year', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreosDeMexicoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 mx ', { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${CORREOS_DE_MEXICO_PAGE}?guia=${KNOWN}`);
    expect(correosDeMexicoLookupUrl(KNOWN)).toBe(url);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Accept-Language': 'es-MX' } });
    expect(init.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correos-de-mexico', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('posts the form back for each older year, with the last page’s fields, until the history reaches its first event', async () => {
    const fetcher = site();
    const result = await carrier(fetcher).track({ number: SPLIT });
    expect(requests(fetcher)).toEqual([`GET ${correosDeMexicoLookupUrl(SPLIT)}`, `POST ${correosDeMexicoLookupUrl(SPLIT)} 2025`]);
    const init = fetcher.mock.calls[1]![1]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: CORREOS_DE_MEXICO_ORIGIN, Referer: correosDeMexicoLookupUrl(SPLIT) } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ __EVENTTARGET: 'Busqueda', __EVENTARGUMENT: '',
      __VIEWSTATE: 'SyntheticViewStateSplitCurrent', __VIEWSTATEGENERATOR: '0000AAAA', __EVENTVALIDATION: 'SyntheticEventValidationSplitCurrent',
      Guia: SPLIT, Periodo: '2025' });
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-01-03T11:26:00-06:00' });
    expect(result.history_truncated).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-01-03T11:26:00-06:00', 'Entrega', 'Administración Postal Barrio Sintético, Yuc.', 'delivered'],
      ['2026-01-03T08:52:00-06:00', 'Con mensajero para entrega', 'Administración Postal Barrio Sintético, Yuc.', 'out_for_delivery'],
      ['2026-01-02T09:44:00-06:00', 'Recepción en Oficina de Correos', 'Administración Postal Barrio Sintético, Yuc.', 'in_transit'],
      ['2025-12-31T16:20:00-06:00', 'En tránsito hacia destino', 'Centro de Distribución Sintético, Yuc.', 'in_transit'],
      ['2025-12-31T07:15:00-06:00', 'Recepción en Oficina de Correos', 'Centro de Distribución Sintético, Yuc.', 'in_transit'],
      ['2025-12-29T17:48:00-06:00', 'En tránsito hacia destino', 'Centro de Atención al Público Sintético, Ver.', 'in_transit'],
      ['2025-12-29T12:05:00-06:00', 'Depósito en Oficina de Correos', 'Centro de Atención al Público Sintético, Ver.', 'accepted'],
    ]);
  });

  it('marks a history truncated when the years before it are no longer offered or hold nothing for it', async () => {
    const alone = page('split-2026').replace(/\t<option value="2025">2025<\/option>\n\t<option value="2024">2024<\/option>\n/, '');
    const offered = site({ [SPLIT]: { 2026: alone } });
    await expect(carrier(offered).track({ number: SPLIT })).resolves.toMatchObject({ history_truncated: true, status: 'delivered' });
    expect(offered).toHaveBeenCalledTimes(1);
    const empty = site({ [SPLIT]: { 2026: page('split-2026') } });
    const result = await carrier(empty).track({ number: SPLIT });
    expect(result).toMatchObject({ history_truncated: true });
    expect(result.events).toHaveLength(3);
    expect(requests(empty)).toEqual([`GET ${correosDeMexicoLookupUrl(SPLIT)}`, `POST ${correosDeMexicoLookupUrl(SPLIT)} 2025`,
      `POST ${CORREOS_DE_MEXICO_PAGE} 2024`]);
    expect(new URLSearchParams(String(empty.mock.calls[2]![1]!.body)).get('__VIEWSTATE')).toBe(`SyntheticViewStateMissing2025`);
    // A year whose scans do not come before the later year's is not the same history.
    const unrelated = site({ [SPLIT]: { 2026: page('split-2026'), 2025: forYear(page('split-2026'), '2025') } });
    await expect(carrier(unrelated).track({ number: SPLIT })).resolves.toMatchObject({ history_truncated: true, events: { length: 3 } });
    expect(unrelated).toHaveBeenCalledTimes(2);
  });

  it('reads an item found only in an older year, and a number missing only once every offered year has no information on it', async () => {
    const older = site({ [SPLIT]: { 2025: page('split-2025') } });
    const result = await carrier(older).track({ number: SPLIT });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2025-12-31T16:20:00-06:00', events: { length: 4 } });
    expect(result.history_truncated).toBeUndefined();
    expect(older).toHaveBeenCalledTimes(2);
    const absent = site();
    await expect(carrier(absent).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests(absent)).toEqual([`GET ${correosDeMexicoLookupUrl(ABSENT)}`, `POST ${correosDeMexicoLookupUrl(ABSENT)} 2025`,
      `POST ${CORREOS_DE_MEXICO_PAGE} 2024`]);
  });

  it('reads an item delivered at the door newest first, offices on central time on Mexico City’s clock and others as wall clocks', () => {
    const result = read('delivered', KNOWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega', last_update: '2026-03-06T13:20:00-06:00', expected_delivery: null,
      delivered_at: '2026-03-06T13:20:00-06:00' });
    expect(result.pickup_point).toBeUndefined();
    // The clocks order two scans the sequence gives the other way round.
    expect(rows(result)).toEqual([
      ['2026-03-06T13:20:00-06:00', 'Entrega', 'Administración Postal Lomas Sintéticas, Gto.', 'delivered'],
      ['2026-03-06T09:21:00-06:00', 'Con mensajero para entrega', 'Administración Postal Lomas Sintéticas, Gto.', 'out_for_delivery'],
      ['2026-03-06T09:18:00-06:00', 'Recepción en Oficina de Correos', 'Administración Postal Lomas Sintéticas, Gto.', 'in_transit'],
      ['2026-03-04T19:45:00-06:00', 'En tránsito hacia destino', 'Centro de Distribución Oper. Sintético, CDMX.', 'in_transit'],
      ['2026-03-04T08:12:00-06:00', 'Recepción en Oficina de Correos', 'Centro de Distribución Oper. Sintético, CDMX.', 'in_transit'],
      ['local 2026-03-02T16:30:00', 'En tránsito hacia destino', 'Administración Postal Playas Sintéticas, B.C.', 'in_transit'],
      ['local 2026-03-02T11:05:00', 'Depósito en Oficina de Correos', 'Administración Postal Playas Sintéticas, B.C.', 'accepted'],
    ]);
    for (const [name, number] of [['delivered', KNOWN], ['abroad', OTHER], ['inbound', INBOUND]] as const) {
      expect(JSON.stringify(read(name, number)), name).not.toMatch(/DESTINATARIO|Ordinario|Consulta|Recibi/);
    }
  });

  it('reads an item sent abroad, with the foreign post’s scans and the office of exchange on wall clocks', () => {
    const result = read('abroad', OTHER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Entrega Internacional',
      last_update: null, last_update_local: '2026-02-20T16:45:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['local 2026-02-20T16:45:00', 'Entrega Internacional', 'Estados Unidos de América', 'delivered'],
      ['local 2026-02-17T13:22:00', 'Arribo a Zona Intercambio México, en espera de ingreso a la Aduana', 'Estados Unidos de América', 'customs'],
      ['2026-02-14T12:16:00-06:00', 'Pieza depositada en valija y enviada a oficina del País destino', 'COM Sintético Int. D.F.', 'in_transit'],
      ['local 2026-02-12T10:31:00', 'En zona de intercambio int. hacia el país destino, previo Aduana', 'Oficina de Cambio México', 'in_transit'],
      ['2026-02-12T10:29:00-06:00', 'Recepción en Oficina de Correos', 'Oficina Operativa Sintética EXP, CDMX', 'in_transit'],
      ['2026-02-10T14:51:00-06:00', 'En tránsito hacia destino', 'Administración Postal Valle Sintético, Jal.', 'in_transit'],
      ['2026-02-09T10:27:00-06:00', 'Depósito en Oficina de Correos', 'Administración Postal Valle Sintético, Jal.', 'accepted'],
    ]);
  });

  it('keeps offices in states with several clocks, or without a state, as wall clocks', () => {
    const scan = (location: string, sequence = 1): CorreosDeMexicoScan =>
      ({ sequence, wall: '2026-06-01T10:00:00', location, description: 'En tránsito hacia destino' });
    const clock = (location: string) => {
      const [event] = correosDeMexicoResult([scan(location)], KNOWN).events!;
      return event!.time ?? `local ${String(event!.local_time)}`;
    };
    for (const location of ['Centro de Distribución Monterrey, N.L.', 'Administración Postal Hermosillo, Son.', 'Sucursal Chihuahua, Chih.',
      'Administración Postal Cancún, Q. Roo.', 'Administración Postal Tepic, Nay.', 'Oficina de Cambio México', 'PELIMA', 'Mex', 'Centro, CDMX extra', '']) {
      expect(clock(location), location).toBe('local 2026-06-01T10:00:00');
    }
    for (const location of ['Administración Postal Ecatepec, Edo. Méx.', 'Administración Postal Toluca, Méx.', 'Centro, S.L.P.',
      'Oficina Operativa Centro,  CDMX.', 'COM Centro Int. D.F.', 'Sucursal Uno, Mich.']) {
      expect(clock(location), location).toBe('2026-06-01T10:00:00-06:00');
    }
    // The same scan seen in two years' pages appears once.
    expect(correosDeMexicoResult([scan('Centro, CDMX', 1), scan('Centro, CDMX', 1)], KNOWN).events).toHaveLength(1);
  });

  it('names the counter an item waits at, and the counter it was collected from', () => {
    const waiting = read('inbound', INBOUND);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Sucursal Puerto Sintético, Q. Roo.', last_update: null, last_update_local: '2026-02-20T12:40:00' });
    expect(rows(waiting).map(([, description, location, stage]) => [description, location, stage]).slice(-3)).toEqual([
      ['Arribo a Zona Intercambio México, en espera de ingreso a la Aduana', 'Oficina de Cambio México', 'customs'],
      ['En zona de intercambio int. hacia el país destino, previo Aduana', 'JP', 'in_transit'],
      ['Deposito del Cliente en Japan', 'JP', 'accepted'],
    ]);
    const collected = withRow(page('inbound'), ['24/02/2026', '17:05:00', 'Sucursal Puerto Sintético, Q. Roo.', 'Entrega']);
    const found = readCorreosDeMexicoPage(collected, INBOUND);
    expect(correosDeMexicoResult(found.scans!, INBOUND)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      pickup_point: 'Sucursal Puerto Sintético, Q. Roo.', last_update_local: '2026-02-24T17:05:00' });
  });

  it('reads the counter wait and the delivery after an item is sent back as its return', () => {
    const waiting = read('returned', OTHER);
    expect(waiting).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Puesta en ventanilla' });
    expect(waiting.pickup_point).toBeUndefined();
    expect(rows(waiting).map(([, description, , stage]) => [description, stage])).toEqual([
      ['Puesta en ventanilla', 'returned'],
      ['Recepción en Oficina de Correos', 'in_transit'],
      ['En tránsito hacia destino', 'in_transit'],
      ['Pieza devuelta por domicilio destino incorrecto', 'returned'],
      ['Recepción en Oficina de Correos', 'in_transit'],
      ['En tránsito hacia destino', 'in_transit'],
    ]);
    const found = readCorreosDeMexicoPage(withRow(page('returned'), ['23/09/2026', '10:10:00', 'Administración Postal Colonia Sintética,  CDMX.', 'Entrega']), OTHER);
    const handed = correosDeMexicoResult(found.scans!, OTHER);
    expect(handed).toMatchObject({ current_stage: 'returned', last_update: '2026-09-23T10:10:00-06:00' });
    expect(handed.delivered_at).toBeUndefined();
    expect(handed.pickup_point).toBeUndefined();
  });

  it('binds the page to the whole number and the year asked, and rejects pages it cannot read', () => {
    const delivered = page('delivered');
    const cases: [string, string, string?, string?][] = [
      [delivered.replace(`value="${KNOWN}" maxlength`, `value="${OTHER}" maxlength`), 'schema'],
      [delivered.replace(`action="./Seguimiento.aspx?guia=${KNOWN}"`, 'action="https://example.com/SSLServicios/SeguimientoEnvio/Seguimiento.aspx"'), 'schema'],
      [delivered.replace(`action="./Seguimiento.aspx?guia=${KNOWN}"`, `action="./Seguimiento.aspx?guia=${OTHER}"`), 'schema'],
      [delivered.replace(`action="./Seguimiento.aspx?guia=${KNOWN}"`, `action="./Seguimiento.aspx?guia=${KNOWN}&amp;x=1"`), 'schema'],
      [delivered.replace(`action="./Seguimiento.aspx?guia=${KNOWN}"`, 'action="./Otra.aspx"'), 'schema'],
      [delivered.replace('method="post"', 'method="get"'), 'schema'],
      [delivered.replace(/<input type="hidden" name="__VIEWSTATE"[^>]*>/, ''), 'schema'],
      [delivered.replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, ''), 'schema'],
      [delivered.replace('name="__VIEWSTATEGENERATOR"', 'name="Extra"'), 'schema'],
      [delivered.replace('id="Busqueda"', 'id="Buscar"'), 'schema'],
      [delivered.replace(' selected="selected"', ''), 'schema'],
      [delivered.replace('value="2025">2025', 'value="25">25'), 'schema'],
      [delivered.replace('<th scope="col">Origen</th>', '<th scope="col">Oficina</th>'), 'schema'],
      [delivered.replace('Total de eventos : 7', 'Total de eventos : 8'), 'schema'],
      [delivered.replace('>06/03/2026<', '>31/02/2026<'), 'schema'],
      [delivered.replace('>13:20:00<', '>13:20<'), 'schema'],
      [delivered.replace('>Entrega</td>', '></td>'), 'schema'],
      [delivered.replace('width:0px;">7<', 'width:0px;"><'), 'schema'],
      [delivered.replace('<span id="lblMensaje"></span>', '<span id="lblMensaje">Error</span>'), 'schema'],
      [delivered.replace(/<\/tr><tr>[\s\S]*<\/tr>\n\t<\/table>/, '</tr>\n\t</table>'), 'indeterminate', undefined, 'no_history'],
      [delivered, 'indeterminate', '2025'],
      [missing(OTHER).replace(`guia=${OTHER}"`, `guia=${KNOWN}"`).replace(`value="${OTHER}" maxlength`, `value="${KNOWN}" maxlength`), 'indeterminate'],
      [missing(KNOWN).replace(/<span id="lblMensaje">[^<]*<\/span>/, '<span id="lblMensaje"></span>'), 'indeterminate'],
      ['<html><body><form id="form2" method="post"></form></body></html>', 'schema'],
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>', 'challenge'],
      ['<html><body><h1>Sitio temporalmente en Mantenimiento</h1><p>Intente de nuevo</p></body></html>', 'indeterminate', undefined, 'maintenance'],
    ];
    for (const [body, kind, year, reason] of cases) {
      const error = failure(() => readCorreosDeMexicoPage(body, KNOWN, year));
      expect(error, body.slice(0, 80)).toMatchObject({ kind, ...(reason ? { reason } : {}) });
    }
    expect(readCorreosDeMexicoPage(delivered, KNOWN, '2026').year).toBe('2026');
    expect(readCorreosDeMexicoPage(missing(KNOWN, '2024'), KNOWN, '2024')).toMatchObject({ year: '2024', olderYears: [], scans: null,
      form: { action: CORREOS_DE_MEXICO_PAGE } });
    expect(readCorreosDeMexicoPage(missing(KNOWN, '2025'), KNOWN, '2025').olderYears).toEqual(['2024']);
  });

  it('takes valid S10 item codes, Mexican or foreign, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015MX', 'ABC12', '', '123456789012', 'MX000000014ZZZ']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(site()).track({ number: INBOUND })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    await expect(carrier(site()).track({ number: 'RR000000014DE' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('recognizes a known item and a number no offered year has information on, from plain HTTP', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).recognize!(KNOWN)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-06T19:20:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reads a redirect to the maintenance page, and any other, as inconclusive', async () => {
    for (const [answer, reason] of [
      [() => redirect('/SSLServicios/SeguimientoEnvio/Mantenimiento.aspx?aspxerrorpath=/SSLServicios/SeguimientoEnvio/Seguimiento.aspx'), 'maintenance'],
      [() => redirect(`${CORREOS_DE_MEXICO_ORIGIN}/sslservicios/seguimientoenvio/mantenimiento.aspx`, 301), 'maintenance'],
      [() => redirect('https://www.gob.mx/correosdemexico'), undefined],
      [() => html(page('delivered').replace('Seguimiento de env&#237;os', 'Sitio temporalmente en Mantenimiento')), 'maintenance'],
    ] as const) {
      const now = site({ [KNOWN]: { 2026: answer } });
      const error = await carrier(now).track({ number: KNOWN }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: 'indeterminate', ...(reason ? { reason } : {}) });
      expect(now).toHaveBeenCalledTimes(1);
      const later = site({ [SPLIT]: { 2026: page('split-2026'), 2025: answer } });
      await expect(carrier(later).track({ number: SPLIT })).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(later).toHaveBeenCalledTimes(2);
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s for the page and for an older year, without a retry or the form’s state in the error', async (status, kind) => {
      for (const [number, pages] of [[KNOWN, { [KNOWN]: { 2026: () => html('<html><body>Unavailable</body></html>', status) } }],
        [SPLIT, { [SPLIT]: { 2026: page('split-2026'), 2025: () => html('<html><body>Unavailable</body></html>', status) } }]] as const) {
        const fetcher = site(pages);
        const error = await carrier(fetcher).track({ number }).catch((caught: unknown) => caught);
        expect(error, number).toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes(number === KNOWN ? 1 : 2);
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/Synthetic(?:ViewState|EventValidation)/);
      }
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site({ [SPLIT]: { 2026: page('split-2026'), 2025: () => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(page('split-2025'));
    } } });
    await expect(carrier(flaky).track({ number: SPLIT })).resolves.toMatchObject({ status: 'delivered', events: { length: 7 } });
    expect(requests(flaky)).toEqual([`GET ${correosDeMexicoLookupUrl(SPLIT)}`, `POST ${correosDeMexicoLookupUrl(SPLIT)} 2025`,
      `GET ${correosDeMexicoLookupUrl(SPLIT)}`, `POST ${correosDeMexicoLookupUrl(SPLIT)} 2025`]);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(down).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: KNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: KNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: KNOWN }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('bounds the size of each reply', async () => {
    const large = site({ [KNOWN]: { 2026: () => new Response(new Uint8Array(1_100_000)) } });
    await expect(carrier(large).track({ number: KNOWN })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Correos de México to the adapter', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: KNOWN, carrier: 'correos-de-mexico' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'correos-de-mexico', source: 'correos-de-mexico', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CORREOS_DE_MEXICO_ORIGIN}/`))).toBe(true);
  });

  it('is asked first about Mexican S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(KNOWN)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(KNOWN)[0]).toBe('correos-de-mexico');
    expect(recognitionAskedCarriers('ZZ000000015MX')).not.toContain('correos-de-mexico');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('correos-de-mexico');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('correos-de-mexico');
  });
});

describe('Correos de México status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(correosDeMexicoScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(correosDeMexicoScanStage('  Entrega  ')).toBe('delivered');
    expect(correosDeMexicoScanStage('Deposito del Cliente en Peru')).toBe('accepted');
    expect(correosDeMexicoScanStage('Pieza devuelta por rehusado')).toBe('returned');
    for (const wording of ['constructor', 'toString', 'Entregado al remitente', 'Pieza devueltas', 'Depósito']) {
      expect(correosDeMexicoScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('X1', 'entrega')).toBeUndefined();
    // Wording the map does not know goes to the shared rules, else stays without a stage.
    expect(correosDeMexicoStage('Entregado al remitente')).toEqual({ stage: 'returned', source: expect.any(String) });
    expect(correosDeMexicoStage('Sin novedad')).toBeNull();
    expect(statusMapAnswer({ carrier: 'correos-de-mexico', description: 'Puesta en ventanilla' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
