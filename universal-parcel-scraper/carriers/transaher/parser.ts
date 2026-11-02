import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { transaherStage } from './status.js';

export const PROVIDER = 'Transaher';
// The tracking box on transaher.es takes numbers starting 103, and its other form 27 digits.
const NUMBER = /^103\d{24}$/;
const NOT_FOUND = /No se ha encontrado la expedici[oó]n indicada/i;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Transaher's tracker; anything else is not one it issues. */
export function normalizeTransaherNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Transaher numbers are 27 digits starting 103');
  return number;
}

/** Upper case without accents, to compare the page's labels. */
const fold = (value: string) => clean(value, 200).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

/** The history grid: the table headed FECHA, HORA and SITUACIÓN. */
function historyTable($: CheerioAPI): Cheerio<Element> | null {
  const tables = $('table').filter((_, table) => $(table).find('thead th').map((__, th) => fold($(th).text())).get()
    .join('|') === 'FECHA|HORA|SITUACION');
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'Transaher returned more than one history');
  return tables.length ? tables.first() : null;
}

/** The grid's rows, without the line it shows when it has none. */
function historyRows($: CheerioAPI, table: Cheerio<Element>): Element[] {
  return table.find('tbody > tr').get().filter((row) => !/emptymessage/.test($(row).attr('class') ?? ''));
}

/**
 * Whether the page rendered so far answers: the tracker's own sentence for a
 * number it does not know, or the shipment's history grid.
 */
export function transaherPageState(html: string): 'not_found' | 'shipment' | 'pending' {
  const $ = load(html);
  if (NOT_FOUND.test(clean($.root().text(), 100_000))) return 'not_found';
  return historyTable($) ? 'shipment' : 'pending';
}

/** The value next to a label in the shipment's summary, which sets each pair in a row of its own. */
function summaryField($: CheerioAPI, label: string): string {
  const rows = $('.row').filter((_, row) => fold($(row).find('label').first().text()) === label);
  if (rows.length > 1) throw new SchemaError(PROVIDER, 'Transaher returned a repeated summary field');
  const labels = rows.first().find('label');
  return labels.length === 2 ? clean(labels.eq(1).text(), 200) : '';
}

/**
 * Whether the summary's expedition number, an agency and a serial such as
 * `123-4567890`, is the requested one's: the number carries each part, in
 * order, the serial padded with zeros.
 */
function isRequestedExpedition(expedition: string, number: string): boolean {
  if (!/^\d+(?:[\s/-]+\d+)*$/.test(expedition)) return false;
  let from = 0;
  for (const part of expedition.match(/\d+/g)!) {
    const digits = part.replace(/^0+(?=\d)/, '');
    const at = number.indexOf(digits, from);
    if (at < 0) return false;
    from = at + digits.length;
  }
  return true;
}

/** A scan's wall clock, from the grid's `dd/MM/yyyy` day and `HH:mm:ss` time. The page names no zone. */
function wallClock(date: string, time: string): string {
  const day = DATE.exec(date);
  const local = day && CLOCK.test(time) ? `${day[3]}-${day[2]}-${day[1]}T${time}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Transaher returned an invalid scan time');
  }
  return local;
}

const PROGRESS: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery'];
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);

/**
 * The current stage: the summary's word for a finished shipment, else
 * whichever of the summary and the newest staged scan has gone further. The
 * summary follows the page's progress rail, which can lag the history.
 */
function currentStage(summary: ClassifiedWording | null, scanned: CarrierEvent | undefined):
  { stage: Stage; source: string; summary: boolean } | undefined {
  const scan = scanned?.stage as Stage | undefined;
  if (summary && (FINAL.has(summary.stage) || !scan
    || (PROGRESS.includes(scan) && PROGRESS.indexOf(summary.stage) > PROGRESS.indexOf(scan)))) {
    return { ...summary, summary: true };
  }
  return scan ? { stage: scan, source: scanned!.stage_source!, summary: false } : undefined;
}

/**
 * The page Transaher's tracker renders for one number, as HTML. The summary's
 * status, expedition number and sender sit over a grid of the situations the
 * shipment went through, oldest first, each with a day and a wall clock. The
 * recipient, the sender's reference, the shipping day, the progress rail and
 * the proof of delivery are not read.
 */
export function parseTransaher(html: string, raw: string): CarrierResult {
  const number = normalizeTransaherNumber(raw);
  const $ = load(html);
  if (NOT_FOUND.test(clean($.root().text(), 100_000))) throw new NotFoundError(PROVIDER);
  const table = historyTable($);
  const summary = summaryField($, 'ESTADO DE TU ENVIO');
  const expedition = summaryField($, 'NUMERO DE EXPEDICION');
  if (!table || !expedition) throw new SchemaError(PROVIDER, 'Transaher returned a page without its shipment');
  if (!isRequestedExpedition(expedition, number)) throw new IndeterminateError(PROVIDER, 'Transaher answered for another shipment');

  const rows = historyRows($, table);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Transaher returned an oversized history');
  const seen = new Set<string>();
  const events: (CarrierEvent & { local_time: string })[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Transaher returned a changed history row');
    const [date, time, description] = [0, 1, 2].map((index) => clean(cells.eq(index).text(), 200));
    if (!description) throw new SchemaError(PROVIDER, 'Transaher returned a scan without wording');
    const local = wallClock(date!, time!);
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = transaherStage(description);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Newest first; scans of one second keep the page's order, turned round.
  const newestFirst = events.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const newest = newestFirst[0];
  const current = currentStage(summary ? transaherStage(summary) : null, newestFirst.find((event) => event.stage));
  if (!newest && !current) throw new NoHistoryError(PROVIDER);
  // The grid pages a long history, oldest first, so a pager hides the newest scans.
  const paged = table.closest('.rz-data-grid').find('[class*="rz-paginator"], [class*="rz-pager"]').length > 0;
  const sender = summaryField($, 'REMITENTE');
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: current?.summary || !newest ? summary : newest.description!,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(sender && !sender.includes('*') ? { sender_name: sender } : {}),
    ...(!newest ? { summary_only: true } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(paged || newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
