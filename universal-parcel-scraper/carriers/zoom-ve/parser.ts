import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { zoomStage, zoomWording } from './status.js';

export const PROVIDER = 'Zoom';
export const ZOOM_MAX_BYTES = 1_000_000;
export const ZOOM_PAGE = 'https://zoom.red/tracking-de-envios-personas/';
// The visible ancestor waits for either a final result or the hidden widget response.
export const ZOOM_READY_SELECTOR = '.zappi-trk-container, body:has(.cf-turnstile input[name="cf-turnstile-response"][value]:not([value=""]))';
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)|No se pudo validar la identidad del usuario/i;
const key = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toUpperCase().replace(/:$/, '');

export function normalizeZoomNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Zoom guias contain ten digits');
  return number;
}

export function zoomTrackingUrl(raw: string): string {
  return `${ZOOM_PAGE}?${new URLSearchParams({ 'nro-guia': normalizeZoomNumber(raw), 'tipo-consulta': '1' })}`;
}

/** A verification redirect may add its one-use token but must retain the whole lookup. */
export function validateZoomResultUrl(rawUrl: string, raw: string): void {
  const number = normalizeZoomNumber(raw);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new TransportError(PROVIDER, 'Zoom returned an invalid tracking address'); }
  if (url.origin !== 'https://zoom.red' || url.username || url.password || url.pathname !== '/tracking-de-envios-personas/' || url.hash
    || [...url.searchParams.keys()].some(name => !['nro-guia', 'tipo-consulta', 'turnstile-token'].includes(name))
    || url.searchParams.getAll('turnstile-token').length > 1) throw new TransportError(PROVIDER, 'Zoom redirected the requested tracking page');
  if (url.searchParams.getAll('nro-guia').length !== 1 || url.searchParams.get('nro-guia') !== number
    || url.searchParams.getAll('tipo-consulta').length !== 1 || url.searchParams.get('tipo-consulta') !== '1') {
    throw new IndeterminateError(PROVIDER, 'Zoom answered a different tracking lookup');
  }
}

function creationYear(text: string): number {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text)) throw new SchemaError(PROVIDER, 'Zoom returned an invalid creation date');
  const date = DateTime.fromFormat(text, 'dd/MM/yyyy', { zone: 'UTC' });
  if (!date.isValid || date.year < 1000 || date.toFormat('dd/MM/yyyy') !== text) throw new SchemaError(PROVIDER, 'Zoom returned an invalid creation day');
  return date.year;
}

/** Each table clock keeps its digits; the creation date settles only its century. */
function wallClock(day: string, time: string, anchorYear: number): string {
  const parts = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(day);
  if (!parts || !/^\d{2}:\d{2}$/.test(time)) throw new SchemaError(PROVIDER, 'Zoom returned an invalid scan clock');
  const base = Math.floor(anchorYear / 100) * 100 + Number(parts[3]);
  const candidates = [base - 100, base, base + 100].sort((left, right) => Math.abs(left - anchorYear) - Math.abs(right - anchorYear));
  if (Math.abs(candidates[0]! - anchorYear) === Math.abs(candidates[1]! - anchorYear)) throw new SchemaError(PROVIDER, 'Zoom returned an ambiguous scan century');
  const text = `${parts[1]}/${parts[2]}/${String(candidates[0]).padStart(4, '0')} ${time}`;
  const date = DateTime.fromFormat(text, 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd/MM/yyyy HH:mm') !== text) throw new SchemaError(PROVIDER, 'Zoom returned an invalid scan day');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The page is a result of one whole-guia GET, including its explicit negative reply. */
export function parseZoom(html: string, raw: string, actualUrl: string): CarrierResult {
  const number = normalizeZoomNumber(raw);
  validateZoomResultUrl(actualUrl, number);
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Zoom requires browser verification');
  const $ = load(html);
  const root = $('.zappi-trk-container');
  if (root.length !== 1) {
    if ($('.cf-turnstile, [name="cf-turnstile-response"]').length) throw new ChallengeError(PROVIDER, 'Zoom has not completed tracking verification');
    throw new SchemaError(PROVIDER, 'Zoom returned no unique tracking result');
  }
  const negative = root.children('.alert.alert-info');
  if (negative.length) {
    if (negative.length !== 1 || root.find('table, .zappi-trk-titulo').length) throw new SchemaError(PROVIDER, 'Zoom returned conflicting tracking results');
    const heading = negative.children('p'), reasons = negative.children('ul').children('li');
    if (negative.children().length === 2 && heading.length === 1 && reasons.length === 1
      && clean(heading.text(), 200) === 'LOS PARAMETROS INGRESADOS NO SON CORRECTOS'
      && clean(reasons.text(), 200) === 'No se ha encontrado el tracking asociado.') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Zoom did not complete its tracking lookup');
  }
  const title = root.children('.zappi-trk-titulo').find('h2');
  const titleText = title.text().replace(/\s+/g, ' ').trim();
  const titleNumber = /^Información del Envío (\d{10})$/i.exec(titleText);
  if (title.length !== 1 || !titleNumber) throw new SchemaError(PROVIDER, 'Zoom returned no unique shipment title');
  if (titleNumber[1] !== number) throw new IndeterminateError(PROVIDER, 'Zoom answered for another shipment');
  const summary = root.children('table.zappi-trk-resumen');
  if (summary.length !== 1) throw new SchemaError(PROVIDER, 'Zoom changed its shipment summary');
  const summaryFields = new Map<string, string>();
  for (const row of summary.find('tr').toArray()) {
    const cells = $(row).children('td');
    if (!cells.length) continue;
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'Zoom changed its summary columns');
    const label = key(cells.eq(0).text());
    if (summaryFields.has(label)) throw new SchemaError(PROVIDER, 'Zoom repeated a shipment summary field');
    summaryFields.set(label, cells.eq(1).text().trim());
  }
  if (summaryFields.get('N° DE GUIA') !== number) throw new IndeterminateError(PROVIDER, 'Zoom did not confirm the requested guia');
  const anchor = creationYear(summaryFields.get('FECHA DE CREACION DEL ENVIO') ?? '');
  const table = root.children('.zappi-trk-estados-tabla').find('table');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Zoom returned no unique scan table');
  const headers = table.find('th').toArray().map(node => key($(node).text()));
  if (headers.join('|') !== '#|FECHA|HORA|ESTATUS|UBICACION|OFICINA') throw new SchemaError(PROVIDER, 'Zoom changed its scan columns');
  const rows = table.find('tr').toArray().filter(node => $(node).children('td').length);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Zoom returned too many scans');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== 6) throw new SchemaError(PROVIDER, 'Zoom returned an invalid scan row');
    const local = wallClock(cells.eq(1).text().trim(), cells.eq(2).text().trim(), anchor);
    const description = clean(zoomWording(cells.eq(3).text().replace(/\s+/g, ' ').trim()), 500);
    if (!description) throw new SchemaError(PROVIDER, 'Zoom returned an unnamed scan');
    const city = clean(cells.eq(4).text(), 160), office = clean(cells.eq(5).text(), 160);
    const location = [...new Set([city, office].filter(Boolean))].join(' · ');
    const identity = JSON.stringify([local, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stage = zoomStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}), ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: events[0]!.description!, last_update: null, last_update_local: events[0]!.local_time!, expected_delivery: null, events,
  };
}
