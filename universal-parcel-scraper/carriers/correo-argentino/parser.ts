import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correoArgentinoStage, scanWording } from './status.js';

export const PROVIDER = 'Correo Argentino';
/** Where the tracking forms on correoargentino.com.ar post a number. */
export const CORREO_ARGENTINO_LOOKUP = 'https://www.correoargentino.com.ar/sites/all/modules/custom/ca_forms/api/wsFacade.php';
// A reply with both histories is about 30 kB, most of it the list of foreign posts' sites.
export const CORREO_ARGENTINO_MAX_BYTES = 1_000_000;

const ZONE = 'America/Argentina/Buenos_Aires';
const MAX_ROWS = 500;
// The international form's history: the UPU's IPS events, as each post recorded them.
const ABROAD = ['Fecha', 'País', 'Oficina', 'Evento', 'Motivo', 'Acción'];
// Correo Argentino's own history, the only one of an item numbered in Argentina.
const DOMESTIC = ['Fecha', 'Planta', 'Historia', 'Estado'];
const ABROAD_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DOMESTIC_CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// The stages of an item's movements, which after its return are the way back.
const RETURN_LEG = new Set<Stage>(['in_transit', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered']);
const PIECE = /^Resultados de la consulta para la pieza:/;
const COUNT = /^Cantidad de movimientos\s*(\d{1,4})$/;
const NO_RESULTS = /^×?\s*No se encontraron resultados$/;
// PHP's own messages, which the lookup prints before its answer when it fails inside.
const SERVER_ERROR = /\b(?:Notice|Warning|Fatal error|Parse error)\s*:/;
// A firewall or bot check's page in place of the reply, which can come with HTTP 200.
const BLOCKED = /Incapsula incident ID|_Incapsula_Resource|<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;

/** Correo Argentino's tracker follows S10 item codes: its own, ending AR, and those other posts send to Argentina. */
export function normalizeCorreoArgentinoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correo Argentino tracks S10 item codes');
}

/**
 * The fields the tracking page posts for a number. An item numbered in
 * Argentina goes to the national form, as its service, nine digits and
 * country; an item from abroad, whole, to the international one.
 */
export function correoArgentinoLookupFields(number: string): URLSearchParams {
  if (number.endsWith('AR')) {
    return new URLSearchParams({ action: 'ondnc', id: number.slice(2, 11), producto: number.slice(0, 2), pais: 'AR' });
  }
  return new URLSearchParams({ action: 'oidn', id: number });
}

/** Whether a reply is a firewall's or bot check's page instead of the tracker's. */
export function isCorreoArgentinoBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

interface Scan {
  /** Its wall clock, `yyyy-MM-ddTHH:mm:ss`. */
  readonly wall: string;
  /** Whether it is on Argentina's clock. */
  readonly domestic: boolean;
  readonly location: string;
  readonly description: string;
}

function headings($: CheerioAPI, table: Element): string[] {
  return $(table).find('thead th').map((_, cell) => clean($(cell).text(), 40)).get();
}

function wallClock(year: string, month: string, day: string, hour: string, minute: string, second = '00'): string {
  const date = calendarDay(Number(year), Number(month), Number(day));
  if (!date || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new SchemaError(PROVIDER, 'Correo Argentino returned a scan without a valid clock');
  }
  return `${date}T${hour}:${minute}:${second}`;
}

/** An IPS row: the post that scanned it, its office and the event's English name. */
function abroadScan(cells: readonly string[]): Scan | null {
  const clock = ABROAD_CLOCK.exec(cells[0]!);
  if (!clock) throw new SchemaError(PROVIDER, 'Correo Argentino returned a scan without a valid clock');
  const [, year, month, day, hour, minute] = clock;
  const description = clean(cells[3], 200);
  if (!description) return null;
  // ISO 3166's English names, as "United States of America (the)".
  const country = clean(cells[1], 80).replace(/\s*\(the\)$/i, '');
  const location = [clean(cells[2], 120), country].filter(Boolean).join(', ');
  return { wall: wallClock(year!, month!, day!, hour!, minute!), domestic: false, location, description };
}

/** A row of Correo Argentino's own history: its plant, the event and, for a delivery visit, how it went. */
function domesticScan(cells: readonly string[]): Scan | null {
  const clock = DOMESTIC_CLOCK.exec(cells[0]!);
  if (!clock) throw new SchemaError(PROVIDER, 'Correo Argentino returned a scan without a valid clock');
  const [, day, month, year, hour, minute, second] = clock;
  const description = scanWording(clean(cells[2], 200), clean(cells[3], 200));
  if (!description) return null;
  return { wall: wallClock(year!, month!, day!, hour!, minute!, second), domestic: true, location: clean(cells[1], 120), description };
}

/** One history table's scans, oldest first, checked against the count the reply prints under it. */
function tableScans($: CheerioAPI, table: Element, count: string | undefined, domestic: boolean): Scan[] {
  const rows = $(table).find('tbody tr').toArray().filter(row => $(row).children('td').length);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correo Argentino returned an oversized history');
  const total = COUNT.exec(count ?? '');
  if (!total || Number(total[1]) !== rows.length) throw new SchemaError(PROVIDER, 'Correo Argentino returned an incomplete history');
  const width = domestic ? DOMESTIC.length : ABROAD.length;
  const scans = rows.map((row) => {
    const cells = $(row).children('td').map((_, cell) => clean($(cell).text(), 300)).get();
    if (cells.length !== width) throw new SchemaError(PROVIDER, 'Correo Argentino history columns changed');
    return domestic ? domesticScan(cells) : abroadScan(cells);
  }).filter((scan): scan is Scan => scan !== null);
  // The national form lists the newest first, the international form the oldest.
  return scans.length > 1 && scans[0]!.wall > scans.at(-1)!.wall ? scans.reverse() : scans;
}

/** When the scan happened: on Argentina's clock for Correo Argentino's own scans, else as a local wall clock. */
function clockOf(scan: Scan): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (scan.domestic) {
    const placed = zonedTime(scan.wall, "yyyy-MM-dd'T'HH:mm:ss", ZONE);
    if (placed?.iso.startsWith(scan.wall)) return { time: placed.iso };
  }
  return { local_time: scan.wall };
}

/**
 * The HTML fragment the tracker answers a form with: the item's history, or a
 * notice. The international form's reply holds the IPS history and, once the
 * item reached Correo Argentino's network, its national history under the
 * number it was given there. Each history is followed by its row count.
 */
export function parseCorreoArgentino(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCorreoArgentinoNumber(rawNumber);
  if (isCorreoArgentinoBlockPage(html)) throw new ChallengeError(PROVIDER, 'Correo Argentino answered with a block page');
  if (!html.trim()) throw new SchemaError(PROVIDER, 'Correo Argentino returned an empty reply');
  const $ = load(html);
  const text = clean($('body').text(), 2_000);
  if (SERVER_ERROR.test(text)) throw new IndeterminateError(PROVIDER, 'Correo Argentino failed to complete the lookup');
  const tables = $('table').toArray();
  if (!tables.length) {
    const alerts = $('.alert');
    // Only the tracker's own notice is a missing item; the page shows another when the lookup fails.
    if (alerts.length === 1 && NO_RESULTS.test(clean(alerts.text(), 200))) throw new NotFoundError(PROVIDER);
    if (alerts.length) throw new IndeterminateError(PROVIDER, 'Correo Argentino did not answer the lookup');
    throw new SchemaError(PROVIDER, 'Correo Argentino returned an unexpected reply');
  }

  const piece = $('p').filter((_, node) => PIECE.test(clean($(node).text(), 200))).first().find('.badge');
  if (piece.length !== 1) throw new SchemaError(PROVIDER, 'Correo Argentino returned a history without its number');
  if (normalizeTrackingNumber(clean(piece.text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Correo Argentino answered for another item');
  }

  const counts = $('p').map((_, node) => clean($(node).text(), 80)).get().filter(line => line.startsWith('Cantidad de movimientos'));
  const domesticOnly = number.endsWith('AR');
  let abroad = 0;
  let domestic = 0;
  const scans = tables.flatMap((table, index) => {
    const columns = JSON.stringify(headings($, table));
    const national = columns === JSON.stringify(DOMESTIC);
    if (national) domestic += 1;
    else if (columns === JSON.stringify(ABROAD) && !domesticOnly) abroad += 1;
    else throw new SchemaError(PROVIDER, 'Correo Argentino history columns changed');
    return tableScans($, table, counts[index], national);
  });
  if (abroad > 1 || domestic > 1 || counts.length !== tables.length) {
    throw new SchemaError(PROVIDER, 'Correo Argentino returned an unexpected reply');
  }

  // Both histories in one timeline, by wall clock; equal clocks keep the reply's order.
  const seen = new Set<string>();
  const chronological = scans
    .map((scan, index) => ({ scan, index }))
    .sort((left, right) => (left.scan.wall < right.scan.wall ? -1 : left.scan.wall > right.scan.wall ? 1 : left.index - right.index))
    .map(({ scan }) => scan)
    .filter((scan) => {
      const identity = JSON.stringify([scan.wall, scan.domestic, scan.location, scan.description]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  if (!chronological.length) throw new NoHistoryError(PROVIDER);

  let returning = false;
  const events: CarrierEvent[] = chronological.map((scan) => {
    const classified = correoArgentinoStage(scan.description);
    // An item unclaimed in time goes back to its sender: what moves it after that is its return.
    const stage = returning && classified && RETURN_LEG.has(classified.stage)
      ? { stage: 'returned' as const, source: 'carrier_map' } : classified;
    returning ||= classified?.stage === 'returned';
    return { ...clockOf(scan), description: scan.description, ...(scan.location ? { location: scan.location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  }).reverse();

  const latest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  // The delivery's time comes from Correo Argentino's own scan, as the IPS rows have no zone.
  const zoned = events.find(event => event.time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(stage === 'delivered' && zoned?.stage === 'delivered' ? { delivered_at: zoned.time! } : {}),
    events,
  };
}
