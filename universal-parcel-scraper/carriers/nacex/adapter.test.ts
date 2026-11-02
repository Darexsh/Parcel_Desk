import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { NacexTracker, adapter } from './adapter.js';
import { nacexPlace } from './identity.js';
import { normalizeNacexNumber, parseNacex, validateNacexBootstrap } from './parser.js';
import { classifyNacexStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '9900/99000002';
const OTHER = '9900/99000003';
const html = readFileSync(new URL('./fixtures/history.html', import.meta.url), 'utf8');
const bootstrap = '<form name="seguimientoFormulario" method="post" action="/seguimientoFormulario.do;jsessionid=synthetic.server:node-route"><input name="agencia_origen"><input name="numero_albaran"></form>';
const negative = '<div class="Z3"><h2>Formulario de Seguimiento</h2><div class="t9">No existe ningún albarán introducido en el sistema cumpliendo los criterios especificados.<br>Consulte con su agencia NACEX más cercana.</div></div>';
const detailPath = (number = NUMBER) => { const [agency, albaran] = number.split('/') as [string, string];
  return '/seguimientoDetalle.do?' + new URLSearchParams({ agencia_origen: agency, numero_albaran: albaran, estado: '1', internacional: '0', externo: 'N', usr: 'null', pas: 'null' }).toString(); };
const response = (body = html, headers: HeadersInit = {}) => new Response(Buffer.from(body, 'latin1'), { headers: { 'Content-Type': 'text/html; charset=ISO-8859-1', ...Object.fromEntries(new Headers(headers)) } });
const freshSession = () => response(bootstrap, { 'Set-Cookie': 'JSESSIONID="synthetic.server:first-route"; Path=/; HttpOnly' });
const redirect = (location = detailPath()) => new Response(null, { status: 302, headers: { Location: location, 'Set-Cookie': 'JSESSIONID=synthetic-second; Path=/; HttpOnly' } });
const edit = (change: (document: ReturnType<typeof load>) => void) => { const $ = load(html); change($); return $.html(); };
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('NACEX direct tracking', () => {
  it('projects identity-bound calendar-grouped scans, repeated positions and safe movement localities', () => {
    const result = normalizeCarrierResult(parseNacex(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', stage: 'delivered', local_time: '2026-01-16' });
    expect(result.events?.[0]!.location).toBeUndefined();
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', location: 'TEST LOCALITY' });
    expect(result.events?.[2]!.stage).toBe('ready_for_pickup');
    // The same scan again, but for its place among the day's scans.
    expect({ ...result.events?.[1], tie_order: 0 }).toEqual({ ...result.events?.[3], tie_order: 0 });
    expect(result.events?.[4]).toMatchObject({ description: 'Cambio de dirección', local_time: '2026-01-15', stage: 'in_transit' });
    expect(result.events?.[5]).toMatchObject({ description: 'Solución de entrega concertada', stage: 'in_transit' });
    expect(result.events?.[5]!.location).toBeUndefined();
    expect(result.events?.[6]!.stage).toBe('failed_attempt');
    expect(result.events?.[11]).toMatchObject({ description: 'Notificado', stage: 'accepted', stage_source: 'none' });
    expect(result.events?.[13]).toMatchObject({ description: 'Notificado', stage: 'registered' });
    expect(result.events?.[13]!.stage_source).toBeUndefined();
    // A heading dates its scans to the day: no clock time, offset or instant is invented.
    expect(result.events?.every(event => !event.time && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))
      && !event.provider_time_text && !event.provider_code)).toBe(true);
    expect(result.events?.[13]!.local_time).toBe('2026-01-14');
    expect(result.last_update_local).toBe('2026-01-16');
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const entry of statuses.entries.filter(entry => entry.wording !== 'Sin estado')) expect(classifyNacexStatus(entry.wording)?.stage).toBe(entry.stage);
    for (const word of ['constructor', 'toString', 'Sin estado', 'Será entregado']) expect(classifyNacexStatus(word)).toBeUndefined();
  });

  it('reads headings in Spanish as well as English', () => {
    const body = edit($ => $('.sg_hist_fecha').each((index, node) => { $(node).text(['16 enero 2026', '15 ENERO 2026', '14 Septiembre 2026'][index]!); }));
    expect([...new Set(parseNacex(body, NUMBER).events?.map(event => event.local_time))]).toEqual(['2026-01-16', '2026-01-15', '2026-09-14']);
    for (const text of ['16 constructor 2026', '16 de enero de 2026', '16/01/2026']) {
      const event = parseNacex(edit($ => $('.sg_hist_fecha').first().text(text)), NUMBER).events?.[0];
      expect(event).toMatchObject({ provider_time_text: text });
      expect(event?.local_time).toBeUndefined();
    }
  });

  it('times the delivery and keeps the estimate from the block above the history', () => {
    const block = (heading: string, date: string, label: string, clock: string, part = 'fecha_entrega') => `<div class="sg_fondo_estado">${heading}<br>`
      + `<div class="text_capitalize ${part}"><div><span>Friday</span><br><font size="+1"> ${date}</font></div></div>`
      + `<div class="div_hr_vertical"><hr class="hr_vertical"></div><div class="${part}"><div><span>${label}</span><br><font size="+1"> ${clock}</font></div></div></div>`;
    const delivered = (markup: string) => parseNacex(edit($ => { $('#tabla_estado').after(markup); }), NUMBER);
    const result = normalizeCarrierResult(delivered(block('FECHA DE ENTREGA', '16/01', 'Hora entrega', '17:02')));
    expect(result).toMatchObject({ status: 'delivered', last_update_local: '2026-01-16T17:02:00' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', local_time: '2026-01-16T17:02:00' });
    expect(result.events?.slice(1).every(event => /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.expected_delivery ?? undefined).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    // No place names a zone: the delivery takes the home clock of NACEX's first country.
    expect(dateLocalClocks('nacex', result).events?.[0]).toMatchObject({ local_time: '2026-01-16T17:02:00', time_zone: 'Europe/Madrid', time_zone_basis: 'carrier' });
    // The time binds only to a delivery on the block's day, in its delivered form.
    for (const markup of [block('FECHA DE ENTREGA', '15/01', 'Hora entrega', '17:02'), block('FECHA DE ENTREGA', '16/01', 'Hora máxima', '17:02'),
      block('FECHA DE ENTREGA', '16/01', 'Hora entrega', '25:00'), block('FECHA DE ENTREGA', '16-01', 'Hora entrega', '17:02'),
      block('FECHA', '16/01', 'Hora entrega', '17:02'), block('FECHA DE ENTREGA', '16/01', 'Hora entrega', '17:02').repeat(2)]) {
      expect(delivered(markup).events?.[0]!.local_time).toBe('2026-01-16');
    }
    const progress = (date: string, newest = '15 January 2026', status = 'En reparto', part = 'fecha_objetivo') => parseNacex(edit($ => {
      $('#tabla_estado').after(block('FECHA ESTIMADA DE ENTREGA', date, 'Hora máxima', '19:00', part));
      $('#tabla_estado tr').eq(1).children('td').last().text(status);
      $('#table_historico').html(`<tr><td class="sg_hist_fecha" colspan="2">${newest}</td></tr>`
        + `<tr><td class="sg_hist_desc"><b>${status}</b><br>9901 - TEST LOCALITY</td></tr>`);
    }), NUMBER);
    expect(progress('15/01')).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-01-15', last_update_local: '2026-01-15' });
    expect(progress('15/01').events?.[0]!.local_time).toBe('2026-01-15');
    expect(progress('19/01').expected_delivery).toBe('2026-01-19');
    expect(progress('02/01', '31 December 2026').expected_delivery).toBe('2027-01-02');
    // An estimate the history has passed is stale.
    expect(progress('14/01').expected_delivery).toBeUndefined();
    expect(progress('31/02').expected_delivery).toBeUndefined();
    expect(progress('15/01', undefined, undefined, 'fecha_entrega').expected_delivery).toBeUndefined();
    // An incident closed without success keeps the estimate it missed, which no longer holds.
    expect(progress('15/01', undefined, 'Solucionado sin OK')).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(progress('15/01', undefined, 'Solucionado sin OK').expected_delivery).toBeUndefined();
  });

  it('validates composite input and both summary and expanded detail identity', () => {
    expect(normalizeNacexNumber('9900 / 99000002')).toBe(NUMBER);
    for (const number of ['', '123', '990099000002', '9900/9900002', '9900/990000002', NUMBER + '?', 'ABCD/99000002']) expect(() => normalizeNacexNumber(number)).toThrow(InvalidInputError);
    for (const body of [edit($ => $('#tabla_estado tr').first().children('td').last().text(OTHER)),
      edit($ => $('#tabla_estado').clone().appendTo('body')), edit($ => $('#table_historico').clone().appendTo('body')),
      edit($ => $('.fuente_label').filter((_,n) => $(n).text() === 'Agencia origen').first().parent().append('9')),
      edit($ => $('.fuente_label').filter((_,n) => $(n).text() === 'Nº Albarán').parent().remove()),
      edit($ => $('#tabla_estado tr').eq(1).children('td').first().text('Different field'))]) {
      expect(() => parseNacex(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses only the explicit scoped no-shipment page, never a hidden phrase or empty guest summary', () => {
    expect(() => parseNacex(negative, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [bootstrap + negative.replace('class="Z3"', 'class="hidden"'), '<html>Maintenance</html>',
      negative.replace('No existe ningún albarán', 'Servicio no disponible'), edit($ => $('#table_historico').remove())]) {
      expect(() => parseNacex(body, NUMBER)).toThrow();
      expect(() => parseNacex(body, NUMBER)).not.toThrowError(expect.objectContaining({ kind: 'not_found' }));
    }
  });

  it('keeps unknown current wording and unresolved newest date labels without deriving older delivery', () => {
    for (const clock of ['', 'Tomorrow', '31 February 2026']) {
      const body = edit($ => {
        $('#tabla_estado tr').eq(1).children('td').last().text('Nuevo estado');
        $('.sg_hist_fecha').first().text(clock);
        $('.sg_hist_desc').first().children('font').text('Nueva gestión');
        $('.sg_hist_desc').eq(1).children('b').text('Entregado');
      });
      const result = parseNacex(body, NUMBER);
      expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Nuevo estado', last_update: null });
      expect(result.current_stage).toBeUndefined();
      expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.description).toBe('Nueva gestión');
      expect(result.events?.[0]!.provider_time_text).toBe(clock || undefined);
      expect(result.events?.[0]!.local_time).toBeUndefined();
      expect(result.last_update_local).toBeUndefined();
    }
  });

  it('stages incident handling, keeps a notice on the stage before it and drops pickup point codes from labels', () => {
    const history = (summary: string, rows: string[]) => edit($ => {
      $('#tabla_estado tr').eq(1).children('td').last().text(summary);
      $('#table_historico').html('<tr><td class="sg_hist_fecha" colspan="2">15 January 2026</td></tr>'
        + rows.map(row => `<tr><td class="sg_hist_desc">${row}</td></tr>`).join(''));
    });
    const notice = parseNacex(history('Sin estado', ['<b>Sin estado</b>: TEST NOTE', '<b>Ausente</b>', '<b>En reparto</b><br>9901 - TEST LOCALITY',
      '<b>Notificado</b><br>TEST ORIGIN', '<b>Aceptada</b><br>9900 - TEST ORIGIN', '<b>Notificado</b><br>TEST ORIGIN']), NUMBER);
    expect(notice).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Sin estado' });
    expect(notice.events?.map(event => [event.stage, event.stage_source])).toEqual([['failed_attempt', 'none'], ['failed_attempt', undefined],
      ['out_for_delivery', undefined], ['accepted', 'none'], ['accepted', undefined], ['registered', undefined]]);
    expect(parseNacex(history('Notificado', ['<b>Notificado</b><br>TEST ORIGIN']), NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    const incident = parseNacex(history('Solucionado sin OK', ['<b>Solucionado sin OK</b><br>9901 - TEST NOTE',
      '<b>Solución de entrega en punto (9901-123)</b>', '<b>Solución de entrega concertada</b><br>9901 - TEST NOTE',
      '<b>Contacta con agencia (9901)</b>', '<b>En reparto</b><br>9901 - TEST LOCALITY']), NUMBER);
    expect(incident).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Solucionado sin OK' });
    expect(incident.events?.map(event => [event.provider_status, event.stage, event.location])).toEqual([
      ['Solucionado sin OK', 'exception', undefined], ['Solución de entrega en punto', 'in_transit', undefined],
      ['Solución de entrega concertada', 'in_transit', undefined], ['Contacta con agencia', 'exception', undefined],
      ['En reparto', 'out_for_delivery', 'TEST LOCALITY']]);
    expect(parseNacex(history('Cambio de dirección (9901)', ['<b>Cambio de dirección (9901)</b>', '<b>En reparto</b><br>9901 - TEST LOCALITY']), NUMBER))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Cambio de dirección' });
    const pickup = edit($ => {
      $('#tabla_estado tr').eq(1).children('td').last()
        .html('<font class="fuente_titulo_green">Disponible en punto NACEX (9901-123)</font><a href="#">990001</a>');
      $('#table_historico').html('<tr><td class="sg_hist_fecha" colspan="2">15 January 2026</td></tr>'
        + '<tr><td class="sg_hist_desc"><font class="fuente_titulo_green">Disponible en punto NACEX</font><a href="#">990001</a><br>9901 - TEST LOCALITY</td></tr>');
    });
    expect(parseNacex(pickup, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', last_status_text: 'Disponible en punto NACEX' });
  });

  it("reads a platform's town without the \"PLAT\" before it", () => {
    const transit = (locality: string) => parseNacex(edit($ => {
      $('#tabla_estado tr').eq(1).children('td').last().text('En tránsito');
      $('#table_historico').html('<tr><td class="sg_hist_fecha" colspan="2">15 January 2026</td></tr>'
        + `<tr><td class="sg_hist_desc"><b>En tránsito</b><br>9900-12 - ${locality}</td></tr>`);
    }), NUMBER).events?.[0]?.location;
    expect(transit('PLATTESTVILLE')).toBe('TESTVILLE');
    expect(transit('PLAT TEST TOWN')).toBe('TEST TOWN');
    expect(transit('PLATJA D ARO')).toBe('PLATJA D ARO');
    expect(nacexPlace('PLATJAEN')).toBe('JAEN');
  });

  it('registers a shipment booked through the web channel until its first movement', () => {
    const history = (summary: string, rows: string[]) => edit($ => {
      $('#tabla_estado tr').eq(1).children('td').last().text(summary);
      $('#table_historico').html('<tr><td class="sg_hist_fecha" colspan="2">15 January 2026</td></tr>'
        + rows.map(row => `<tr><td class="sg_hist_desc">${row}</td></tr>`).join(''));
    });
    const booked = parseNacex(history('Notificado', ['<b>Notificado</b>', '<b>Aceptada</b><br>9900 - WEB']), NUMBER);
    expect(booked).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Notificado' });
    expect(booked.events?.map(event => [event.provider_status, event.stage, event.stage_source, event.location]))
      .toEqual([['Notificado', 'registered', 'none', undefined], ['Aceptada', 'registered', undefined, undefined]]);
    expect(parseNacex(history('Aceptada', ['<b>Aceptada</b><br>9900 - WEB', '<b>Notificado</b>']), NUMBER))
      .toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Aceptada' });
    const moving = parseNacex(history('En tránsito', ['<b>En tránsito</b><br>9900 - TEST ORIGIN', '<b>Notificado</b>', '<b>Aceptada</b><br>9900 - WEB']), NUMBER);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moving.events?.map(event => event.stage)).toEqual(['in_transit', 'registered', 'registered']);
    expect(parseNacex(history('Aceptada', ['<b>Aceptada</b><br>9900 - TEST ORIGIN']), NUMBER))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', events: [{ stage: 'accepted', location: 'TEST ORIGIN' }] });
  });

  it('rejects a delivered header contradicted by the newest mapped scan, allowing newer administrative rows', () => {
    const contradiction = edit($ => {
      $('.sg_hist_desc').first().children('font').text('En reparto');
      $('.sg_hist_desc').eq(1).children('b').text('Entregado');
    });
    expect(() => parseNacex(contradiction, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const administrative = edit($ => $('.sg_hist_fecha').first().parent().after('<tr><td class="sg_hist_desc"><b>Notificado</b></td></tr>'));
    expect(parseNacex(administrative, NUMBER)).toMatchObject({ status: 'delivered' });
  });

  it('rejects incomplete history, unsafe labels and administrative-only shells while bounding retained rows', () => {
    for (const body of [edit($ => $('#table_historico tr').first().children('td').attr('colspan', '1')),
      edit($ => $('.sg_hist_desc').first().append('<td>Extra column</td>')),
      edit($ => $('.sg_hist_desc').first().children('font').remove()),
      edit($ => $('.sg_hist_desc').first().append('<b>Another status</b>')),
      edit($ => $('.sg_hist_desc').first().children('font').text('')),
      edit($ => $('#table_historico').html('<tr><td class="unknown">Unexpected content</td></tr>')),
      edit($ => $('#table_historico').append('<tr><td class="sg_hist_desc"><b>En reparto</b></td></tr>'.repeat(501)))]) {
      expect(() => parseNacex(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNacex(edit($ => $('#table_historico').empty()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNacex(edit($ => $('#table_historico').html('<tr><td class="sg_hist_desc"><b>Sin estado</b>: TEST NOTE</td></tr>')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseNacex(edit($ => $('#table_historico').append('<tr><td class="sg_hist_desc"><b>En reparto</b></td></tr>'.repeat(120))), NUMBER).events).toHaveLength(100);
  });

  it('requires the current anonymous form shape, with only a same-origin observed target', () => {
    expect(() => validateNacexBootstrap(bootstrap)).not.toThrow();
    for (const body of ['', bootstrap.replace('method="post"', 'method="get"'), bootstrap + bootstrap,
      bootstrap.replace('/seguimientoFormulario.do;jsessionid=synthetic.server:node-route', 'https://other.test/seguimientoFormulario.do'),
      bootstrap.replace('synthetic.server:node-route', 'a'.repeat(257)),
      bootstrap.replace('synthetic.server:node-route', 'synthetic%3Aroute'),
      bootstrap.replace('name="agencia_origen"', 'name="other"')]) {
      expect(() => validateNacexBootstrap(body)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses an isolated anonymous cookie with two form fields, one exact redirect and no browser or verification input', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      const index = fetcher.mock.calls.length - 1;
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      if (index === 0) { expect(String(url)).toBe('https://www.nacex.es/irSeguimiento.do'); expect(headers.has('cookie')).toBe(false); return freshSession(); }
      if (index === 1) {
        expect(String(url)).toBe('https://www.nacex.es/seguimientoFormulario.do');
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toBe('agencia_origen=9900&numero_albaran=99000002');
        expect(headers.get('cookie')).toBe('JSESSIONID="synthetic.server:first-route"');
        expect(headers.has('origin')).toBe(false); expect(headers.has('referer')).toBe(false);
        return redirect();
      }
      expect(String(url)).toBe('https://www.nacex.es' + detailPath());
      expect(headers.get('cookie')).toBe('JSESSIONID=synthetic-second');
      return response();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: NUMBER, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('recognizes matching history without ranking calendar days and reports only proven negatives as absent', async () => {
    const positive = vi.fn().mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(redirect()).mockResolvedValueOnce(response());
    const instance = adapter(environment(positive));
    expect(await instance.recognize!('invalid')).toEqual({ known: false });
    expect(positive).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-16T00:00:00' });
    const absent = vi.fn().mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(response(negative));
    expect(await adapter(environment(absent as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    expect(absent).toHaveBeenCalledTimes(2);
    const outage = vi.fn().mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(response('<html>Unavailable</html>'));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects different, duplicated, credentialed or international redirect parameters before requesting them', async () => {
    const paths = [detailPath(OTHER), detailPath().replace('estado=1', 'estado='), detailPath().replace('internacional=0', 'internacional=1'),
      detailPath().replace('externo=N', 'externo=S'), detailPath().replace('usr=null', 'usr=private'), detailPath().replace('pas=null', 'pas=private'),
      detailPath() + '&agencia_origen=9900', detailPath() + '&other=1', detailPath() + '#fragment',
      'https://other.test' + detailPath(), 'https://user:password@www.nacex.es' + detailPath(),
      '/other.do?' + detailPath().split('?')[1], 'not a URL'];
    for (const location of paths) {
      const fetcher = vi.fn().mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(redirect(location));
      await expect(new NacexTracker({ fetcher: fetcher as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps session jars separate and refuses missing/oversized issued state without leaking it across lookups', async () => {
    for (const cookie of [undefined, 'JSESSIONID=', 'JSESSIONID=' + 'a'.repeat(257), 'JSESSIONID="' + 'a'.repeat(257) + '"', 'JSESSIONID="unterminated', 'JSESSIONID=invalid/value']) {
      const fetcher = vi.fn(async () => response(bootstrap, cookie ? { 'Set-Cookie': cookie } : {})) as unknown as typeof fetch;
      await expect(new NacexTracker({ fetcher }).fetch(NUMBER)).rejects.toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn().mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(response(negative))
      .mockResolvedValueOnce(freshSession()).mockResolvedValueOnce(response(negative));
    const tracker = new NacexTracker({ fetcher: fetcher as unknown as typeof fetch });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(new Headers(fetcher.mock.calls[2]![1].headers).has('cookie')).toBe(false);
  });

  it('preserves HTTP failure taxonomy at every phase and limits streaming bodies without retries', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      for (const phase of [0, 1, 2]) {
        const fetcher = vi.fn();
        if (phase > 0) fetcher.mockResolvedValueOnce(freshSession());
        if (phase > 1) fetcher.mockResolvedValueOnce(redirect());
        fetcher.mockResolvedValueOnce(new Response(negative, { status }));
        await expect(new NacexTracker({ fetcher: fetcher as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes(phase + 1);
      }
    }
    const fetcher = vi.fn(async () => new Response(new Uint8Array(1_000_001))) as unknown as typeof fetch;
    await expect(new NacexTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors caller cancellation before and during bootstrap without continuing the session', async () => {
    const immediate = vi.fn(async () => freshSession()) as unknown as typeof fetch;
    await expect(new NacexTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new NacexTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const waiting = vi.fn(async (_url, init) => {
      await new Promise((_resolve, reject) => { init?.signal?.throwIfAborted(); init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
      return freshSession();
    }) as unknown as typeof fetch;
    const active = new NacexTracker({ fetcher: waiting }).fetch(NUMBER, { signal: controller.signal });
    controller.abort();
    await expect(active).rejects.toMatchObject({ kind: 'transport' });
    expect(waiting).toHaveBeenCalledTimes(1);
  });

  it('recomputes a fractional whole-lookup deadline and rejects any late response', async () => {
    for (const phase of [0, 1, 2]) {
      const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
        const index = fetcher.mock.calls.length - 1;
        // Simulate a transport that finishes after ignoring its cancellation. The budget
        // leaves the requests before it time to answer under a loaded test run.
        if (index === phase) await new Promise(resolve => setTimeout(resolve, 150));
        return index === 0 ? freshSession() : index === 1 ? redirect() : response();
      });
      await expect(new NacexTracker({ fetcher }).fetch(NUMBER, { budgetMs: 120.5 })).rejects.toMatchObject({ kind: 'budget' });
      expect(fetcher).toHaveBeenCalledTimes(phase + 1);
    }
  });
});
