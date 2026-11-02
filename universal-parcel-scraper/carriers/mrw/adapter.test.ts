import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { resultTimezone } from '../../core/time/result.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { MrwTracker, adapter } from './adapter.js';
import { normalizeMrwNumber, parseMrwBootstrap, parseMrwHistory, parseMrwSummary } from './parser.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyMrwStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '99000Z000001';
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url)), 'utf8');
const summary = () => parseMrwSummary(fixture('summary'), NUMBER);
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('MRW anonymous tracking', () => {
  it('supports only the two complete native reference shapes', () => {
    expect(normalizeMrwNumber(' 99000z000001 ')).toBe(NUMBER);
    expect(normalizeMrwNumber('990000000001')).toBe('990000000001');
    for (const raw of ['', '99000Z00001', '99000ZZ000001', NUMBER + '?', 'X'.repeat(49)]) {
      expect(() => normalizeMrwNumber(raw)).toThrow(InvalidInputError);
    }
  });

  it('binds both summary and full history to the requested reference and projects only actual scans', () => {
    const parsed = normalizeCarrierResult(parseMrwHistory(fixture('history'), NUMBER, summary()));
    expect(parsed).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-09-10T19:29:00+02:00',
      delivered_at: '2026-09-10T19:29:00+02:00', last_status_text: 'Envío entregado' });
    expect(parsed.last_update_local).toBeUndefined();
    expect(parsed.events).toHaveLength(5);
    expect(parsed.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'failed_attempt', 'in_transit', 'registered']);
    expect(parsed.events?.[0]).toEqual({ description: 'Envío entregado', provider_status: 'Envío entregado', stage: 'delivered',
      time: '2026-09-10T19:29:00+02:00', location: '02600 Ejemplo' });
    // A pickup point's code names no province, and no office of the history is in its town, so its scan keeps its wall clock.
    expect(parsed.events?.map(event => event.time ?? event.local_time)).toEqual(['2026-09-10T19:29:00+02:00', '2026-09-10T13:40:00',
      '2026-09-09T16:47:00+02:00', '2026-09-07T14:03:00+02:00', '2026-09-04T17:10:00+02:00']);
    expect(parsed.events?.[1]).toMatchObject({ local_time: '2026-09-10T13:40:00', location: '40000 Muestra' });
    // The host and aggregators relaying the wall clocks left read them in Spanish time.
    expect(resultTimezone('mrw', parsed)).toBe('Europe/Madrid');
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_SYNTHETIC_ADDRESS');
    for (const entry of statuses.entries) expect(classifyMrwStatus(entry.wording)?.stage).toBe(entry.stage);
  });

  it('accepts a bound current status when the official history page is blank, without a synthetic scan', () => {
    // The summary names no office, so its clock stays local.
    expect(parseMrwHistory(fixture('blank-history'), NUMBER, summary())).toEqual({ status: 'delivered',
      current_stage: 'delivered', last_status_text: 'Envío entregado', last_update: null,
      last_update_local: '2026-09-10T19:29:00', expected_delivery: null, summary_only: true, events: [] });
    expect(parseMrwHistory(fixture('blank-history'), NUMBER, { ...summary(), date: '31/02/2026' }).last_update_local).toBeUndefined();
    expect(() => parseMrwHistory(fixture('blank-history'), NUMBER, { ...summary(), status: 'ENTREGADO A PRIVATE_SYNTHETIC' }))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a query echo without a shipment table as no history', () => {
    expect(() => parseMrwSummary(fixture('unknown-summary'), '99999Z999999'))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects changed form, wrong identity, ambiguous summaries and forged history links', () => {
    expect(() => parseMrwBootstrap(fixture('bootstrap').replace('validar-envio.asp', 'changed.asp')))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMrwSummary(fixture('summary').replace(NUMBER, '99000Z000002'), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMrwSummary(fixture('summary').replace('envio=99000Z000001', 'envio=99000Z000002'), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMrwSummary(fixture('summary').replace('</tbody>', '<tr><td>99000Z000002</td></tr></tbody>'), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMrwHistory(fixture('history').replace('Seguimiento del número de envío 99000Z000001',
      'Seguimiento del número de envío 99000Z000002'), NUMBER, summary()))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not infer delivery from an older row or recipient-like wording', () => {
    const altered = fixture('history').replace('10/09/2026</td><td>19:29</td><td>Envío entregado',
      '31/02/2026</td><td>19:29</td><td>ENTREGADO A PRIVATE_SYNTHETIC_RECIPIENT');
    const result = parseMrwHistory(altered, NUMBER, { ...summary(), date: '31/02/2026', status: 'ENTREGADO A PRIVATE_SYNTHETIC_RECIPIENT' });
    expect(result).toMatchObject({ status: 'unknown', last_update: null });
    expect(result.current_stage).toBeUndefined();
    expect(result.last_update_local).toBeNull();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]!.description).toBe('Actualización de seguimiento');
    expect(result.events?.[0]!.provider_time_text).toBe('31/02/2026 19:29');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC_RECIPIENT');
    // Its status map leaves the label out on purpose and gives the other scans the parser's stage.
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual([normalizeStatusWording(result.events![0]!.description ?? '')]);
    for (const event of result.events!) {
      expect(statusMap.stage(null, normalizeStatusWording(event.description ?? '')), event.description).toBe(event.stage);
    }
  });

  it('skips the per-parcel scans and keeps hub labels', () => {
    const breakdown = '<tr id="infoBultos2" class="table-bultos"><td class="hidden-xs"></td><td colspan="2"><div class="table-responsive">'
      + '<table class="zebra alt" title="Desglose de bultos"><thead><tr><th>Bulto</th><th>Fecha</th><th>Hora</th></tr></thead>'
      + '<tbody><tr><td>001</td><td>07/09/2026</td><td>14:03</td></tr><tr><td>002</td><td>07/09/2026</td><td>13:58</td></tr></tbody></table></div></td></tr>';
    const html = fixture('history').replace('<td>07/09/2026</td><td>14:03</td><td>En tránsito</td><td>02699 Ejemplo (Plataforma)</td></tr>',
      `<td>07/09/2026</td><td>14:03</td><td>En tránsito</td><td>00000 Example (Plataforma)</td></tr>${breakdown}`);
    const result = parseMrwHistory(html, NUMBER, summary());
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'failed_attempt', 'in_transit', 'registered']);
    expect(result.events?.[3]).toMatchObject({ local_time: '2026-09-07T14:03:00', location: '00000 Example (Plataforma)' });
    expect(parseMrwHistory(fixture('history'), NUMBER, summary()).events?.[3])
      .toMatchObject({ time: '2026-09-07T14:03:00+02:00', location: '02699 Ejemplo (Plataforma)' });
    const loose = html.replace('title="Desglose de bultos"', 'title="Otro"');
    expect(() => parseMrwHistory(loose, NUMBER, summary())).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an agreed delivery in transit', () => {
    const arranged = fixture('history').replace('10/09/2026</td><td>19:29</td><td>Envío entregado',
      '10/09/2026</td><td>19:29</td><td>Entrega concertada');
    const result = parseMrwHistory(arranged, NUMBER, { ...summary(), status: 'Entrega concertada' });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Entrega concertada' });
    expect(result.events?.[0]).toMatchObject({ description: 'Entrega concertada', stage: 'in_transit' });
  });

  it('reads the Portuguese wordings www.mrw.pt renders', () => {
    const portuguese = fixture('history').replace(/Envío entregado/g, 'Envio entregue')
      .replace('Depositado en PointCorner destino', 'Depositado no PointCorner destino')
      .replace('Destinatario ausente o cerrado', 'Destinatário ausente ou fechado')
      .replace('En tránsito', 'Em tránsito').replace('Pendiente de recoger', 'Pendente de recolher');
    const result = parseMrwHistory(portuguese, NUMBER, { ...summary(), status: 'Envio entregue' });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Envio entregue' });
    expect(result.events?.map(event => [event.description, event.stage])).toEqual([['Envio entregue', 'delivered'],
      ['Depositado no PointCorner destino', 'ready_for_pickup'], ['Destinatário ausente ou fechado', 'failed_attempt'],
      ['Em tránsito', 'in_transit'], ['Pendente de recolher', 'registered']]);
    expect(classifyMrwStatus('Em trânsito')?.stage).toBe('in_transit');
    expect(classifyMrwStatus('ACORDADA PRÓXIMA ENTREGA')?.stage).toBe('in_transit');
  });

  it('rejects summary/history disagreement instead of promoting a stale terminal result', () => {
    for (const changed of [{ status: 'En tránsito' }, { date: '11/09/2026' }, { hour: '19:30' }]) {
      expect(() => parseMrwHistory(fixture('history'), NUMBER, { ...summary(), ...changed }))
        .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const empty = fixture('history').replace(/<tr class="past">[\s\S]*?<\/tr>/, '');
    expect(() => parseMrwHistory(empty, NUMBER, summary())).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('matches the summary’s unpadded hour to the history’s padded one', () => {
    // Live shape: before 10:00 the summary writes "9:29" and the history "09:29".
    const early = parseMrwSummary(fixture('summary').replace('<td>19:29</td>', '<td>9:29</td>'), NUMBER);
    expect(early.hour).toBe('09:29');
    const history = fixture('history').replace('<tr class="past"><td>10/09/2026</td><td>19:29</td>', '<tr class="past"><td>10/09/2026</td><td>09:29</td>');
    expect(parseMrwHistory(history, NUMBER, early)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_update: '2026-09-10T09:29:00+02:00' });
    expect(parseMrwHistory(fixture('blank-history'), NUMBER, early).last_update_local).toBe('2026-09-10T09:29:00');
  });

  it('follows a history that runs ahead of the summary once the summary’s own row is in it', () => {
    const reopened = fixture('history').replace('<tr class="past"><td>10/09/2026</td><td>19:29</td>',
      '<tr class="past"><td>10/09/2026</td><td>19:41</td><td>Dirección entrega incorrecta</td><td>02600 Ejemplo</td></tr>'
      + '<tr class="past"><td>10/09/2026</td><td>19:35</td><td>Envío en reparto</td><td>02600 Ejemplo</td></tr>'
      + '<tr class="past"><td>10/09/2026</td><td>19:35</td><td>Envío reabierto para entregar</td><td>02600 Ejemplo</td></tr>'
      + '<tr class="past"><td>10/09/2026</td><td>19:29</td>');
    const result = parseMrwHistory(reopened, NUMBER, summary());
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Dirección entrega incorrecta',
      last_update: '2026-09-10T19:41:00+02:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.slice(0, 4).map(event => [event.description, event.stage])).toEqual([
      ['Dirección entrega incorrecta', 'failed_attempt'], ['Envío en reparto', 'out_for_delivery'],
      ['Envío reabierto para entregar', 'in_transit'], ['Envío entregado', 'delivered']]);
    // A row above the summary's own that is older is not a history running ahead.
    const older = fixture('history').replace('<tr class="past"><td>10/09/2026</td><td>19:29</td>',
      '<tr class="past"><td>10/09/2026</td><td>19:00</td><td>Envío en reparto</td><td>02600 Ejemplo</td></tr><tr class="past"><td>10/09/2026</td><td>19:29</td>');
    expect(() => parseMrwHistory(older, NUMBER, summary())).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  // The fixture's newest row, at a Madrid office, given another office or clock.
  const newest = '<td>10/09/2026</td><td>19:29</td><td>Envío entregado</td><td>02600 Ejemplo</td>';
  const latestAt = (location: string, date = '10/09/2026', hour = '19:29', status = 'Envío entregado') => parseMrwHistory(
    fixture('history').replace(newest, `<td>${date}</td><td>${hour}</td><td>${status}</td><td>${location}</td>`),
    NUMBER, { ...summary(), date, hour, status });

  it('dates the scans of offices whose code settles Madrid\'s clock', () => {
    for (const [location, time] of [
      ['02600 Ejemplo', '2026-09-10T19:29:00+02:00'], ['04800 Ejemplo', '2026-09-10T19:29:00+02:00'],
      ['01002 Ejemplo', '2026-09-10T19:29:00+02:00'], ['02710 Ejemplo', '2026-09-10T19:29:00+02:00'],
      ['00699 Ejemplo De Ejemplo (Plataforma)', '2026-09-10T19:29:00+02:00'],
      ['05200 Gibraltar', '2026-09-10T19:29:00+02:00'], ['06000 Andorra', '2026-09-10T19:29:00+02:00'],
    ] as const) {
      const result = latestAt(location);
      expect(result, location).toMatchObject({ status: 'delivered', last_update: time, delivered_at: time });
      expect(result.last_update_local, location).toBeUndefined();
      expect(result.events?.[0], location).toMatchObject({ time, location });
      expect(result.events?.[0]?.local_time, location).toBeUndefined();
    }
    expect(latestAt('02600 Ejemplo', '15/01/2026').last_update).toBe('2026-01-15T19:29:00+01:00');
    expect(latestAt('06000 Andorra', '15/01/2026').last_update).toBe('2026-01-15T19:29:00+01:00');
  });

  it('keeps the wall clocks of offices whose code does not settle their clock', () => {
    // The Canary Islands, Portugal, an MRW Point, an office named for a Canary Islands town, a postcode and a bare code.
    for (const location of ['04900 Ejemplo', '05000 Ejemplo', '08000 Exemplo', '08099 Exemplo (Plataforma)', '07700 Exemplo',
      '40000 Muestra', '10000 Exemplo', '02600 Telde', '4000-001 Exemplo', '02699', '']) {
      const result = latestAt(location);
      expect(result, location).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-09-10T19:29:00' });
      expect(result.delivered_at, location).toBeUndefined();
      expect(result.events?.[0], location).toMatchObject({ local_time: '2026-09-10T19:29:00' });
      expect(result.events?.[0]?.time, location).toBeUndefined();
      // The older rows keep their own offices' instants.
      expect(result.events?.[2]?.time, location).toBe('2026-09-09T16:47:00+02:00');
    }
  });

  it('keeps the wall clocks of a pickup point whose code reads as a province, with or without its map link', () => {
    const atPoint = parseMrwHistory(fixture('history')
      .replace('>40000 Muestra</a>', '>02650 Muestra</a>').replace(newest, newest.replace('02600 Ejemplo', '02650 Muestra')),
    NUMBER, summary());
    expect(atPoint).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-09-10T19:29:00' });
    expect(atPoint.events?.slice(0, 3).map(event => [event.location, event.time, event.local_time])).toEqual([
      ['02650 Muestra', undefined, '2026-09-10T19:29:00'], ['02650 Muestra', undefined, '2026-09-10T13:40:00'],
      ['02600 Ejemplo', '2026-09-09T16:47:00+02:00', undefined]]);
  });

  it('dates a pickup point on the clock of an office of its town in the same history', () => {
    // The point's delivery and drop-off, in the town of the office that brought the parcel.
    const atPoint = parseMrwHistory(fixture('history').replace('>40000 Muestra</a>', '>40000 Ejemplo</a>')
      .replace(newest, newest.replace('02600 Ejemplo', '40000 Ejemplo')), NUMBER, summary());
    expect(atPoint).toMatchObject({ status: 'delivered', last_update: '2026-09-10T19:29:00+02:00', delivered_at: '2026-09-10T19:29:00+02:00' });
    expect(atPoint.events?.slice(0, 2).map(event => [event.location, event.time])).toEqual([
      ['40000 Ejemplo', '2026-09-10T19:29:00+02:00'], ['40000 Ejemplo', '2026-09-10T13:40:00+02:00']]);
    // An office of that town whose code does not settle its clock leaves the point on its wall clock.
    for (const office of ['04900 Ejemplo', '08000 Ejemplo']) {
      const unsettled = parseMrwHistory(fixture('history').replace('>40000 Muestra</a>', '>40000 Ejemplo</a>')
        .replace(newest, newest.replace('02600 Ejemplo', office)), NUMBER, summary());
      expect(unsettled.events?.[1], office).toMatchObject({ location: '40000 Ejemplo', local_time: '2026-09-10T13:40:00' });
      expect(unsettled.events?.[1]?.time, office).toBeUndefined();
    }
  });

  it('keeps a clock the change to summer time skips and reads a repeated one as its first occurrence', () => {
    expect(latestAt('02600 Ejemplo', '29/03/2026', '02:30')).toMatchObject({ last_update: null, last_update_local: '2026-03-29T02:30:00' });
    expect(latestAt('02600 Ejemplo', '29/03/2026', '03:30').last_update).toBe('2026-03-29T03:30:00+02:00');
    expect(latestAt('02600 Ejemplo', '25/10/2026', '02:30').last_update).toBe('2026-10-25T02:30:00+02:00');
    expect(latestAt('02600 Ejemplo', '25/10/2026', '03:30').last_update).toBe('2026-10-25T03:30:00+01:00');
  });

  it('takes the last update from the newest row only, and the delivery instant only from a delivery', () => {
    const moving = latestAt('02600 Ejemplo', '10/09/2026', '19:29', 'Envío en reparto');
    expect(moving).toMatchObject({ status: 'out_for_delivery', last_update: '2026-09-10T19:29:00+02:00' });
    expect(moving.delivered_at).toBeUndefined();
    expect(moving.last_update_local).toBeUndefined();
    // A delivery at a pickup point keeps its wall clock; the older rows' instants are not promoted.
    const atPoint = latestAt('40000 Muestra');
    expect(atPoint).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-09-10T19:29:00' });
    expect(atPoint.delivered_at).toBeUndefined();
  });

  it('keeps the wording and stage of the franchise, hold and return rows', () => {
    for (const [status, overall, stage] of [
      ['Pendiente de recibir en destino', 'in_transit', 'in_transit'], ['Recibido en Franquicia de destino', 'in_transit', 'in_transit'],
      ['Concertada próxima entrega', 'in_transit', 'in_transit'],
      ['Entrega aplazada pendiente de cobro o cita previa', 'exception', 'exception'],
      ['Pendiente de recibir datos de entrega', 'exception', 'exception'], ['Dirección entrega incompleta', 'exception', 'exception'],
      ['Devuelto al remitente', 'exception', 'returned'],
    ] as const) {
      const result = latestAt('02600 Ejemplo', '10/09/2026', '19:29', status);
      expect(result, status).toMatchObject({ status: overall, current_stage: stage, last_status_text: status,
        last_update: '2026-09-10T19:29:00+02:00' });
      expect(result.events?.[0], status).toMatchObject({ description: status, provider_status: status, stage });
      expect(result.delivered_at, status).toBeUndefined();
    }
  });

  it('calls the exact anonymous five-step sequence with one cookie jar through the full factory', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const step = fetcher.mock.calls.length;
      expect(init?.cache).toBe('no-store'); expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (step === 1) {
        expect(String(url)).toBe('https://www.mrw.es/seguimiento/');
        return new Response(fixture('bootstrap'), { headers: [
          ['set-cookie', 'ASPSESSIONIDABCDEFGH=syntheticSession; Path=/; HttpOnly'],
          ['set-cookie', 'TS01dc4fc6=syntheticEdge; Path=/; Secure'],
        ] });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toContain('ASPSESSIONIDABCDEFGH=syntheticSession');
      expect(headers.get('cookie')).toContain('TS01dc4fc6=syntheticEdge');
      if (step === 2) {
        expect(String(url)).toBe('https://www.mrw.es/seguimiento/validar-envio.asp');
        expect(init?.method).toBe('POST');
        expect(new URLSearchParams(String(init?.body)).get('mrw-finder-follow-code')).toBe(NUMBER);
        return new Response('', { status: 302, headers: { Location: 'envio-actual.asp' } });
      }
      if (step === 3) { expect(String(url)).toBe('https://www.mrw.es/seguimiento/envio-actual.asp'); return new Response(fixture('summary')); }
      if (step === 4) { expect(String(url)).toContain(`envio=${NUMBER}`); return new Response('', { status: 302, headers: { Location: 'envio-historico.asp' } }); }
      expect(String(url)).toBe('https://www.mrw.es/seguimiento/envio-historico.asp');
      return new Response(fixture('history'));
    });
    const result = await adapter(environment(fetcher)).track({ number: NUMBER, postcode: 'PRIVATE_SYNTHETIC' });
    expect(result).toMatchObject({ status: 'delivered' });
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
  }, 10_000);

  it('keeps HTTP failures and official rate limits distinct from shipment absence', async () => {
    for (const [status, kind] of [[302, 'indeterminate'], [404, 'indeterminate'], [410, 'indeterminate'],
      [403, 'challenge'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(new MrwTracker({ fetcher, paceMs: 0 }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(500_001)));
    await expect(new MrwTracker({ fetcher: oversized, paceMs: 0 }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const landing = new Response(fixture('bootstrap'), { headers: {
      'set-cookie': 'ASPSESSIONIDABCDEFGH=syntheticSession; Path=/',
    } });
    const redirectedLimit = vi.fn<typeof fetch>().mockResolvedValueOnce(landing)
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: '/error/429.asp?motivo=60' } }));
    await expect(new MrwTracker({ fetcher: redirectedLimit, paceMs: 0 }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    expect(redirectedLimit).toHaveBeenCalledTimes(2);
    const external = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('bootstrap'), { headers: {
      'set-cookie': 'ASPSESSIONIDABCDEFGH=syntheticSession; Path=/',
    } })).mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://example.invalid/parcel' } }));
    await expect(new MrwTracker({ fetcher: external, paceMs: 0 }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(external).toHaveBeenCalledTimes(2);
  });

  it('bounds the whole session, including pacing, and honors caller cancellation', async () => {
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('bootstrap')));
    await expect(new MrwTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 }))
      .rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const first = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('bootstrap'), { headers: {
      'set-cookie': 'ASPSESSIONIDABCDEFGH=syntheticSession; Path=/',
    } }));
    await expect(new MrwTracker({ fetcher: first }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: 'budget' });
    expect(first).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const waiting = vi.fn<typeof fetch>(async (_url, init) => {
      signalStarted();
      await new Promise((_resolve, reject) => {
        init?.signal?.throwIfAborted();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return new Response(fixture('bootstrap'));
    });
    const active = new MrwTracker({ fetcher: waiting }).fetch(NUMBER, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(active).rejects.toMatchObject({ kind: 'transport' });
    expect(waiting).toHaveBeenCalledTimes(1);
  });
});
