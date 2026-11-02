import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, firstOccurrence, regionHasTown, townKey } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { classifyMrwStatus, MRW_NEUTRAL_STATUS } from './status.js';

const ORIGIN = 'https://www.mrw.es';
const SUMMARY_HEADERS = 'Número de albarán|Fecha|Hora|Estado envío|Histórico de envío';
const HISTORY_HEADERS = 'Fecha|Hora|Estado envío|Ubicación';

/** A clock with its hour zero-padded: the summary writes "1:59" where the history writes "01:59". */
function paddedHour(value: string): string {
  return value.replace(/^(\d):/, '0$1:');
}

export function normalizeMrwNumber(raw: string): string {
  if (raw.length > 48) throw new InvalidInputError('MRW', 'MRW tracking number is too long');
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (/^(?:\d{12}|\d{5}[A-Z]\d{6})$/.test(number)) return number;
  throw new InvalidInputError('MRW', 'MRW requires a complete 12-character tracking number');
}

export interface MrwSummary {
  number: string;
  status: string;
  date: string;
  hour: string;
  historyUrl: string;
}

export function parseMrwBootstrap(html: string): void {
  const $ = load(html);
  const form = $('form#seguimiento_envios');
  if (form.length !== 1 || form.attr('action') !== 'validar-envio.asp'
    || form.find('input[name="mrw-finder-follow-code"]').length !== 1) {
    throw new SchemaError('MRW', 'Anonymous tracking form changed');
  }
}

export function parseMrwSummary(html: string, raw: string): MrwSummary {
  const number = normalizeMrwNumber(raw);
  const $ = load(html);
  const tables = $('#seguimientoEnvio table.zebra');
  if (!tables.length) {
    // The anonymous portal echoes even synthetic unknown references and does
    // not distinguish them from shipments outside its lookup range: either way
    // it holds no history for the number, which is not proof it never existed.
    throw new NoHistoryError('MRW', 'MRW returned no identifiable shipment');
  }
  if (tables.length !== 1 || tables.find('thead th').map((_, el) => clean($(el).text(), 64)).get().join('|') !== SUMMARY_HEADERS) {
    throw new SchemaError('MRW', 'Summary table changed');
  }
  const rows = tables.find('tbody tr');
  if (rows.length !== 1) throw new IndeterminateError('MRW', 'MRW returned an ambiguous shipment group');
  const cells = rows.first().children('td');
  if (cells.length !== 5 || clean(cells.eq(0).text(), 48) !== number) {
    throw new SchemaError('MRW', 'Summary does not identify the requested shipment');
  }
  const status = clean(cells.eq(3).text(), 200);
  const date = clean(cells.eq(1).text(), 32);
  const hour = paddedHour(clean(cells.eq(2).text(), 16));
  if (!status || status.length > 160) throw new SchemaError('MRW', 'Summary has no bounded status');
  const button = cells.eq(4).find('button[title="Consultar histórico"]');
  const relative = /^javascript:location\.href='([^'\r\n]{1,300})'$/.exec(button.attr('onclick') ?? '')?.[1];
  let url: URL;
  try { url = new URL(relative ?? '', `${ORIGIN}/seguimiento/`); }
  catch { throw new SchemaError('MRW', 'History link is invalid'); }
  if (button.length !== 1 || !relative || url.origin !== ORIGIN || url.pathname !== '/seguimiento/envio-historico.asp'
    || url.searchParams.get('envio') !== number || url.searchParams.get('Inter') !== 'false'
    || [...url.searchParams.keys()].sort().join('|') !== 'Inter|envio') {
    throw new SchemaError('MRW', 'History link does not bind the requested shipment');
  }
  return { number, status, date, hour, historyUrl: url.toString() };
}

function buildLocalDate(rawDate: string, rawHour: string): { local_time?: string; provider_time_text?: string } {
  const date = clean(rawDate, 32);
  const hour = clean(rawHour, 16);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hour);
  if (match && clock) {
    const day = calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
    if (day) return { local_time: `${day}T${clock[1]}:${clock[2]}:00` };
  }
  const text = clean(`${date} ${hour}`, 64);
  return text ? { provider_time_text: text } : {};
}

/** A row's day and minute in an order strings sort by, or empty when unreadable. */
function sortableClock(row: { date: string; hour: string }): string {
  return buildLocalDate(row.date, row.hour).local_time ?? '';
}

function officeLabel(value: string): string {
  const text = clean(value, 80);
  // Hubs carry their kind in brackets, such as "(Plataforma)".
  return /^(?:\d{5}|\d{4}-\d{3})\s+[\p{L} .'-]{2,70}(?: \([\p{L} ]{2,30}\))?$/u.test(text) ? text : '';
}

/**
 * The zone of an office's clock, read from its code, which opens with its
 * province's number: 001 to 048 for mainland Spain and the Balearic Islands,
 * Ceuta's and Melilla's offices among them, 052 for Gibraltar and 060 for
 * Andorra, all on Madrid's clock. The Canary Islands' 049 and 050 and
 * Portugal's 070 to 089 keep clocks of their own, and nothing shows whether
 * their rows are written on the office's clock or on Madrid's. Those, and an
 * office named for a town of the Canary Islands, have none. A pickup point's
 * code names no province, but an office of its town hands it the parcel: a
 * point in the town of an office of the same history keeps that office's zone.
 */
function officeZone(location: string, points: ReadonlySet<string>, townZones: ReadonlyMap<string, string | null> = new Map()): string | null {
  const office = /^((\d{3})\d{2})\s+(.+?)(?: \([\p{L} ]+\))?$/u.exec(location);
  if (!office || regionHasTown('ES-CN', office[3]!)) return null;
  if (points.has(office[1]!)) return townZones.get(townKey(office[3]!)) ?? null;
  const province = Number(office[2]);
  if (province >= 1 && province <= 48) return 'Europe/Madrid';
  return province === 52 ? 'Europe/Gibraltar' : province === 60 ? 'Europe/Andorra' : null;
}

/** A wall clock's instant in the zone; none for a clock the zone skips when its clocks go forward. */
function instant(wall: string, zone: string): string | null {
  const placed = firstOccurrence(DateTime.fromISO(wall, { zone }));
  return placed.isValid && placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall ? placed.toISO({ suppressMilliseconds: true }) : null;
}

/** A row's clock: an instant when its office settles the zone, else the wall clock or the text as shown. */
function rowClock(rawDate: string, rawHour: string, location: string, points: ReadonlySet<string>, townZones: ReadonlyMap<string, string | null>): { time?: string; local_time?: string; provider_time_text?: string } {
  const clock = buildLocalDate(rawDate, rawHour);
  const zone = location ? officeZone(location, points, townZones) : null;
  const time = zone && clock.local_time ? instant(clock.local_time, zone) : null;
  return time ? { time } : clock;
}

function summaryOnly(summary: MrwSummary): CarrierResult {
  const mapped = classifyMrwStatus(summary.status);
  if (!mapped) throw new IndeterminateError('MRW', 'MRW returned only an unrecognized summary');
  // The summary's date and hour are those of its current status, as the
  // history's first row shows. It names no office, so its clock stays local.
  const clock = buildLocalDate(summary.date, summary.hour).local_time;
  return { status: mapped.status, current_stage: mapped.stage, last_status_text: clean(summary.status, 160),
    last_update: null, ...(clock ? { last_update_local: clock } : {}), expected_delivery: null, summary_only: true, events: [] };
}

export function parseMrwHistory(html: string, raw: string, summary: MrwSummary): CarrierResult {
  const number = normalizeMrwNumber(raw);
  if (summary.number !== number) throw new SchemaError('MRW', 'Summary reference changed');
  const $ = load(html);
  const tables = $('#seguimientoEnvio table#grdHistorico');
  if (!tables.length) {
    const text = clean($('#seguimientoEnvio').text(), 200);
    if (/^Histórico de envío nacional ?VOLVER$/.test(text)) return summaryOnly(summary);
    throw new IndeterminateError('MRW', 'MRW returned no usable history page');
  }
  const subtitle = clean($('#seguimientoEnvio h2.page-subtitle').text(), 120);
  if (tables.length !== 1 || subtitle !== `Seguimiento del número de envío ${number}`
    || tables.children('thead').find('th').map((_, el) => clean($(el).text(), 64)).get().join('|') !== HISTORY_HEADERS) {
    throw new SchemaError('MRW', 'History does not identify the requested shipment');
  }
  // Rows that list each parcel's own scans sit between the shipment's rows.
  const rows = tables.children('tbody').children('tr')
    .filter((_, row) => !$(row).hasClass('table-bultos') || $(row).find('table[title="Desglose de bultos"]').length !== 1);
  if (!rows.length) throw new IndeterminateError('MRW', 'Shipment history is empty');
  if (rows.length > 500) throw new SchemaError('MRW', 'Shipment history is unexpectedly large');
  // A pickup point's place links to its map; a later row there, such as the
  // collection, shows its code without the link.
  const points = new Set(rows.toArray().flatMap((row) => {
    const place = $(row).children('td').eq(3);
    const code = /^\d{5}(?=\s)/.exec(officeLabel(place.text()))?.[0];
    return code && place.find('a[onclick*="openMap"]').length ? [code] : [];
  }));
  // The zones of the offices' towns, for the points among them; none for a town whose offices disagree.
  const townZones = new Map<string, string | null>();
  for (const row of rows.toArray()) {
    const location = officeLabel($(row).children('td').eq(3).text());
    const town = /^\d{5}\s+(.+?)(?: \([\p{L} ]+\))?$/u.exec(location)?.[1];
    if (!town || points.has(location.slice(0, 5))) continue;
    const zone = officeZone(location, points);
    const key = townKey(town);
    townZones.set(key, townZones.has(key) && townZones.get(key) !== zone ? null : zone);
  }
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // MRW renders the current row first. Do not promote an older dated row when
  // the current scan has an unresolved clock or unrecognized status.
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError('MRW', 'Incomplete history row');
    const date = clean(cells.eq(0).text(), 32);
    const hour = paddedHour(clean(cells.eq(1).text(), 16));
    const rawStatus = clean(cells.eq(2).text(), 500);
    if (!rawStatus || rawStatus.length > 160) throw new SchemaError('MRW', 'History row lacks a bounded status');
    // Read visible text only. The PointCorner link embeds a full store address
    // and map arguments in onclick; they must never enter the result.
    const location = officeLabel(cells.eq(3).text());
    const clock = rowClock(date, hour, location, points, townZones);
    const key = JSON.stringify([date, hour, rawStatus, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = classifyMrwStatus(rawStatus);
    events.push({ description: mapped ? rawStatus : MRW_NEUTRAL_STATUS,
      ...(mapped ? { provider_status: rawStatus, stage: mapped.stage } : {}),
      ...clock, ...(location ? { location } : {}) });
  }
  const latest = events[0]!;
  const listed = rows.toArray().map((row) => {
    const cells = $(row).children('td');
    return { status: clean(cells.eq(2).text(), 500), date: clean(cells.eq(0).text(), 32), hour: paddedHour(clean(cells.eq(1).text(), 16)) };
  });
  // The summary can lag the history: a delivery reopened and attempted again
  // is listed above the delivery the summary still shows. The summary's own
  // row must be in the history, with only later rows above it.
  const at = listed.findIndex((row) => row.status === summary.status && row.date === summary.date && row.hour === summary.hour);
  const shown = at > 0 ? sortableClock(listed[at]!) : '';
  if (at < 0 || (at > 0 && (!shown || listed.slice(0, at).some((row) => !(sortableClock(row) >= shown))))) {
    throw new IndeterminateError('MRW', 'Current summary and history disagree');
  }
  const mapped = classifyMrwStatus(listed[0]!.status);
  // The newest row's instant is the last update, and the delivery's when it delivered.
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time ?? null }),
    ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    expected_delivery: null, events: events.slice(0, 100) };
}
