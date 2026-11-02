import { load, type CheerioAPI } from 'cheerio';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { nacexPlace } from './identity.js';
import { classifyNacexStatus, isNacexMovement, isNacexNotice } from './status.js';

// Headings name the month in the request's language: English without one, Spanish with `es`.
const MONTHS = new Map([['january', 'enero'], ['february', 'febrero'], ['march', 'marzo'], ['april', 'abril'],
  ['may', 'mayo'], ['june', 'junio'], ['july', 'julio'], ['august', 'agosto'], ['september', 'septiembre'],
  ['october', 'octubre'], ['november', 'noviembre'], ['december', 'diciembre']]
  .flatMap((names, index) => names.map(name => [name, index + 1] as const)));

/** A calendar heading's day, or null for any other text. */
function headingDay(text: string): string | null {
  const match = /^(\d{1,2}) (\p{L}{3,10}) (\d{4})$/u.exec(text);
  const month = match ? MONTHS.get(match[2]!.toLocaleLowerCase('es-ES')) : undefined;
  return match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
}

/**
 * The block above the history: "FECHA DE ENTREGA" with "Hora entrega" once delivered,
 * "FECHA ESTIMADA DE ENTREGA" with "Hora máxima", the latest time, before. Its date has no year.
 */
const SUMMARY_FORMS = [
  { delivered: true, heading: 'FECHA DE ENTREGA', parts: '.fecha_entrega', label: 'Hora entrega' },
  { delivered: false, heading: 'FECHA ESTIMADA DE ENTREGA', parts: '.fecha_objetivo', label: 'Hora máxima' },
];

function summaryDate($: CheerioAPI): { delivered: boolean; monthDay: string; month: number; day: number; clock: string } | null {
  const block = $('.sg_fondo_estado');
  const heading = clean(block.contents().filter((_, node) => node.nodeType === 3).map((_, node) => $(node).text()).get().join(' '), 80);
  const form = SUMMARY_FORMS.find(candidate => candidate.heading === heading);
  const parts = form ? block.children(form.parts) : undefined;
  if (block.length !== 1 || !form || parts?.length !== 2 || clean(parts.eq(1).find('span').text(), 40) !== form.label) return null;
  const date = /^(\d{2})\/(\d{2})$/.exec(clean(parts.eq(0).find('font').text(), 20));
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(clean(parts.eq(1).find('font').text(), 20))?.[0];
  return date && clock ? { delivered: form.delivered, monthDay: `${date[2]}-${date[1]}`, month: Number(date[2]), day: Number(date[1]), clock } : null;
}

/** The day of `month` and `day` nearest `near`, a day of the history. */
function nearestDay(near: string, month: number, day: number): string | null {
  const year = Number(near.slice(0, 4));
  const distance = (candidate: string) => Math.abs(Date.parse(candidate) - Date.parse(near));
  return [year - 1, year, year + 1].map(candidate => calendarDay(candidate, month, day)).filter(candidate => candidate !== null)
    .sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

const AGENCY_CODE = /\s*\(\d{4}(?:-\d{1,3})?\)$/;
/** An acceptance placed at the agency's web channel: the shipment is booked online, not yet in NACEX's hands. */
const WEB_CHANNEL = /^\d{4}(?:-\d{1,3})?\s*-\s*WEB$/i;
const BOOKED: ClassifiedStatus = { status: 'pending', stage: 'registered' };
const NO_HISTORY ='No existe ningún albarán introducido en el sistema cumpliendo los criterios especificados. Consulte con su agencia NACEX más cercana.';

export function normalizeNacexNumber(raw: string): string {
  const number = raw.replace(/\s/g, '');
  if (!/^\d{4}\/\d{8}$/.test(number)) throw new InvalidInputError('NACEX', 'NACEX requires an agency and eight-digit shipment number');
  return number;
}

export function validateNacexBootstrap(html: string): void {
  const $ = load(html);
  const form = $('form[name="seguimientoFormulario"]');
  let action: URL;
  try { action = new URL(form.attr('action') ?? '', 'https://www.nacex.es'); }
  catch { throw new SchemaError('NACEX', 'NACEX tracking form changed'); }
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post'
    || action.origin !== 'https://www.nacex.es' || action.search || action.hash
    || action.pathname.replace(/;jsessionid=[A-Za-z0-9._:-]{1,256}$/, '') !== '/seguimientoFormulario.do'
    || form.find('input[name="agencia_origen"]').length !== 1
    || form.find('input[name="numero_albaran"]').length !== 1) {
    throw new SchemaError('NACEX', 'NACEX tracking form changed');
  }
}

export function parseNacex(html: string, raw: string): CarrierResult {
  const number = normalizeNacexNumber(raw);
  const [agency, albaran] = number.split('/');
  const $ = load(html);
  const summary = $('#tabla_estado');
  const history = $('#table_historico');
  if (!summary.length && !history.length) {
    const negative = $('.Z3 .t9').clone();
    negative.find('br').replaceWith(' ');
    // This is a scoped result of the submitted anonymous form, not a generic
    // HTTP error or a hidden no-results message in the initial form.
    if ($('.Z3 h2').length === 1 && clean($('.Z3 h2').text(), 80) === 'Formulario de Seguimiento'
      && negative.length === 1 && clean(negative.text(), 300) === NO_HISTORY) {
      throw new NotFoundError('NACEX');
    }
    throw new IndeterminateError('NACEX', 'NACEX did not return shipment history');
  }
  if (summary.length !== 1 || history.length !== 1) throw new SchemaError('NACEX', 'NACEX returned ambiguous shipment history');
  const summaryRows = summary.find('tr');
  const identity = summaryRows.eq(0).children('td');
  const statusCells = summaryRows.eq(1).children('td');
  if (identity.length !== 2 || clean(identity.eq(0).text(), 40) !== 'Envío:' || clean(identity.eq(1).text(), 40) !== number
    || statusCells.length !== 2 || clean(statusCells.eq(0).text(), 40) !== 'Estado:') {
    throw new SchemaError('NACEX', 'NACEX returned a different or incomplete shipment');
  }
  const metadata = $('#capa_detalle_no_loginado .fuente_label');
  for (const [label, expected] of [['Agencia origen', agency], ['Nº Albarán', albaran]]) {
    const values = metadata.filter((_, node) => clean($(node).text(), 40) === label).map((_, node) => {
      const parent = $(node).parent().clone();
      parent.children().remove();
      return clean(parent.text(), 40);
    }).get();
    if (!values.length || values.length > 2 || values.some(value => value !== expected)) {
      throw new SchemaError('NACEX', 'NACEX returned a different or ambiguous shipment detail');
    }
  }
  // The current status is a label like a scan's, with the same pickup point
  // link or parenthetical agency or pickup point code after it.
  const summaryCell = statusCells.eq(1);
  const summaryLabels = summaryCell.children('b, font.fuente_titulo_green');
  const summaryLabel = clean(summaryLabels.length === 1 ? summaryLabels.text() : summaryCell.text(), 120).replace(AGENCY_CODE, '');
  if (!summaryLabel || !/^[\p{L}][\p{L}\s().-]{1,119}$/u.test(summaryLabel)) throw new SchemaError('NACEX', 'NACEX returned an invalid current status');
  const rows = history.find('tr');
  if (!rows.length) throw new IndeterminateError('NACEX', 'NACEX returned empty shipment history');
  if (rows.length > 500) throw new SchemaError('NACEX', 'NACEX returned too many scans');
  const scans: { event: CarrierEvent; mapped?: ClassifiedStatus; notice: boolean }[] = [];
  let dayText = '';
  let day: string | null = null;
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 1) throw new SchemaError('NACEX', 'NACEX history columns changed');
    const cell = cells.eq(0);
    if (cell.hasClass('sg_hist_fecha')) {
      if (cell.attr('colspan') !== '2') throw new SchemaError('NACEX', 'NACEX history date layout changed');
      dayText = clean(cell.text(), 64);
      day = headingDay(dayText);
      continue;
    }
    if (!cell.hasClass('sg_hist_desc')) throw new SchemaError('NACEX', 'NACEX history scan layout changed');
    const labels = cell.children('b, font.fuente_titulo_green');
    // Comments, signatures and contact instructions follow this label as
    // separate text nodes. A parenthetical agency or pickup point is routing
    // detail, not code.
    const label = clean(labels.text(), 160).replace(AGENCY_CODE, '');
    if (labels.length !== 1 || !/^[\p{L}][\p{L}\s.-]{1,119}$/u.test(label)) {
      throw new SchemaError('NACEX', 'NACEX returned an invalid scan label');
    }
    const trailing = clean(cell.contents().filter((_, node) => node.nodeType === 3).map((_, node) => $(node).text()).get().join(' '), 300);
    const booked = classifyNacexStatus(label)?.stage === 'accepted' && WEB_CHANNEL.test(trailing);
    const mapped = booked ? BOOKED : classifyNacexStatus(label);
    // The same trailing column holds a recipient after delivery. Only the
    // observed depot/locality shape of a movement scan is a location.
    const locality = !booked && isNacexMovement(label) && /^\d{4}(?:-\d{1,3})?\s*-\s*([\p{L}][\p{L}\s.()-]{1,99})$/u.exec(trailing)?.[1];
    scans.push({ mapped, notice: isNacexNotice(label), event: { description: mapped?.status === 'delivered' ? 'Delivered' : label,
      provider_status: label, ...(day ? { local_time: day } : dayText ? { provider_time_text: dayText } : {}),
      ...(locality ? { location: nacexPlace(locality) } : {}) } });
  }
  // Rows run newest first. A notice keeps the stage of the scan before it.
  let previous: ClassifiedStatus | undefined;
  const applied = new Map<CarrierEvent, ClassifiedStatus>();
  for (const scan of [...scans].reverse()) {
    if (scan.notice && previous) {
      applied.set(scan.event, previous);
      Object.assign(scan.event, { stage: previous.stage, stage_source: 'none' });
    } else if (scan.mapped) {
      previous = scan.mapped;
      applied.set(scan.event, scan.mapped);
      scan.event.stage = scan.mapped.stage;
    }
  }
  const events = scans.map(scan => scan.event);
  if (!events.length || !events.some(event => event.stage)) throw new IndeterminateError('NACEX', 'NACEX returned no actual tracking scans');
  // Calendar headings have no scan clock or zone: a scan keeps its day alone.
  // Preserve provider order, including same-day repeated scans.
  // The summary repeats the newest scan's label, read as that scan is.
  const mapped = classifyNacexStatus(summaryLabel);
  const current = isNacexNotice(summaryLabel) || summaryLabel === events[0]!.provider_status ? applied.get(events[0]!) ?? mapped : mapped;
  const latestPhysical = scans.find(scan => scan.mapped && !scan.notice);
  if (mapped?.stage === 'delivered' && latestPhysical?.mapped?.stage !== 'delivered') {
    throw new SchemaError('NACEX', 'NACEX current status contradicts its latest shipment scan');
  }
  // The block above the history times the delivery on the newest scan's day, on a wall clock
  // in no stated zone. Before it, its estimate counts from the newest scan's day on, unless
  // an incident holds the parcel.
  const block = summaryDate($);
  const newestDay = /^\d{4}-\d{2}-\d{2}$/.test(events[0]!.local_time ?? '') ? events[0]!.local_time! : null;
  if (block?.delivered && newestDay?.slice(5) === block.monthDay && scans[0]!.mapped?.stage === 'delivered' && !scans[0]!.notice) {
    events[0]!.local_time = `${newestDay}T${block.clock}:00`;
  }
  const estimate = block && !block.delivered && newestDay && current?.stage !== 'exception'
    ? nearestDay(newestDay, block.month, block.day) : null;
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: mapped?.status === 'delivered' ? 'Delivered' : summaryLabel,
    last_update: null, ...(events[0]!.local_time ? { last_update_local: events[0]!.local_time } : {}),
    ...(estimate && estimate >= newestDay! ? { expected_delivery: estimate } : {}), events: events.slice(0, 100) };
}
