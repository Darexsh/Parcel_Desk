import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { arasStage } from './status.js';

export const PROVIDER = 'Aras Kargo';

/** Aras Kargo's tracking numbers, as on every label and sample seen. */
const NUMBER = /^\d{13}$/;
/** The lookup page's answer for a number it does not know. */
const ABSENT = 'Girdiğiniz bilgiler için bir sonuç bulunamamıştır.';
/** The summary frame the tracking page opens, bound to the shipment by an opaque id. */
const WAYBILL_FRAME = /^CargoInfoWaybillAndDelivered\.aspx\?shipmentid=[0-9A-F]{32}&subekod=\d{0,6}$/;
const MOVEMENTS_FRAME = 'CargoInfoTransactionAndRedirection.aspx';
const MOVEMENT_HEADER = ['İşlem Tarihi', 'İl', 'Birim', 'İşlem Açıklaması'];
const NON_DELIVERY_HEADER = ['Tarih', 'Teslim Edilememe Nedeni', 'Açıklama'];
const REDIRECTION_HEADER = ['Tarih', 'Kargo Tipi', 'Kargo Durumu', 'Yönlendiren Birim', 'Yönlendirilen Birim', 'Yönlendirme Nedeni'];
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
const MOVING = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery']);

/** A thirteen-digit Aras Kargo tracking number. */
export function normalizeArasNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Aras Kargo tracking numbers are thirteen digits');
  return number;
}

/** A wall clock or a day in the page's day-first form ("3.10.2026 12:01:33", "05.10.2026"). It carries no offset. */
function wallClock(text: string, form: 'day' | 'minute' | 'second'): string | null {
  const shapes = { day: 'd.M.yyyy', minute: 'd.M.yyyy H:mm', second: 'd.M.yyyy H:mm:ss' } as const;
  if (!/^[\d.: ]{8,19}$/.test(text)) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(text, shapes[form], { zone: 'UTC' });
  if (!parsed.isValid) return null;
  return parsed.toFormat(form === 'day' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss");
}

/** The one element with this id, or a schema failure. */
function only($: CheerioAPI, selector: string, what: string) {
  const found = $(selector);
  if (found.length !== 1) throw new SchemaError(PROVIDER, `Aras Kargo ${what} changed`);
  return found;
}

/**
 * A grid's rows as cell texts, after its header. A grid the server did not
 * fill is missing from the page: the session did not carry the shipment.
 */
function grid($: CheerioAPI, id: string, header: readonly string[], what: string): string[][] {
  const tables = $(`table#${id}`);
  if (!tables.length) throw new IndeterminateError(PROVIDER, `Aras Kargo did not return the ${what}`);
  if (tables.length !== 1) throw new SchemaError(PROVIDER, `Aras Kargo repeated the ${what}`);
  const rows = tables.find('tr').toArray().map(row => $(row).children('td').toArray().map(cell => clean($(cell).text(), 200)));
  if (!rows.length || rows[0]!.join('\u0000') !== header.join('\u0000')) throw new SchemaError(PROVIDER, `Aras Kargo ${what} changed`);
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, `Aras Kargo returned too many rows in the ${what}`);
  return rows.slice(1).map(cells => {
    if (cells.length !== header.length) throw new SchemaError(PROVIDER, `Aras Kargo ${what} changed`);
    return cells;
  });
}

/** A movement's place: its unit, then its province unless the unit already names it. */
function place(unit: string, province: string): string {
  if (!unit) return province;
  if (!province || unit === province || unit.startsWith(`${province} `)) return unit;
  return `${unit}, ${province}`;
}

/**
 * The lookup page's answer when it does not open the tracker: its notice
 * for a number it does not know, over the form for that number. Anything else
 * says nothing about the parcel.
 */
export function parseArasLookup(html: string, raw: string): never {
  const number = normalizeArasNumber(raw);
  const $ = load(html);
  const notice = $('span#Label1');
  const form = $('form#form1');
  if (notice.length === 1 && form.length === 1 && clean(notice.text(), 200) === ABSENT
    && form.attr('action') === `./mainpage.aspx?code=${number}`) {
    throw new NotFoundError(PROVIDER);
  }
  throw new IndeterminateError(PROVIDER, 'Aras Kargo did not open the tracker for this number');
}

/** The summary frame of the tracking page, relative to the tracker. */
export function arasWaybillFrame(html: string): string {
  const $ = load(html);
  const panels = $('#tabPanels');
  if (!panels.length) throw new IndeterminateError(PROVIDER, 'Aras Kargo did not return its tracking page');
  const waybill = only($, 'iframe#panel0', 'tracking page').attr('src') ?? '';
  const movements = only($, 'iframe#panel1', 'tracking page').attr('data-src') ?? '';
  if (!WAYBILL_FRAME.test(waybill) || movements !== MOVEMENTS_FRAME) throw new SchemaError(PROVIDER, 'Aras Kargo tracking page changed');
  return waybill;
}

/** Each frame names the number it answers for; an empty one did not get the shipment. */
function bind($: CheerioAPI, selector: string, number: string, what: string): void {
  if ($('html').attr('lang') !== 'tr') throw new SchemaError(PROVIDER, 'Aras Kargo tracking page changed language');
  const shown = $(selector);
  if (shown.length > 1) throw new SchemaError(PROVIDER, `Aras Kargo ${what} changed`);
  const text = clean(shown.text(), 80);
  if (!text) throw new IndeterminateError(PROVIDER, `Aras Kargo did not return the ${what}`);
  if (normalizeTrackingNumber(text) !== number) throw new SchemaError(PROVIDER, 'Aras Kargo returned a different parcel');
}

interface Scan { event: CarrierEvent; local: string; order: number }

/**
 * The tracker's two frames for one parcel: the summary, with the current
 * status, the delivery, the estimate and the days a delivery was not made,
 * and the vehicle movements with any redirection. Names, the signatory, the
 * delivery code, invoice and payment details and every free-text note are
 * never read.
 */
export function parseAras(waybillHtml: string, movementsHtml: string, raw: string): CarrierResult {
  const number = normalizeArasNumber(raw);
  const summary = load(waybillHtml);
  const movements = load(movementsHtml);
  bind(summary, '#labelShipmentCode', number, 'shipment summary');
  bind(movements, '.sno-value', number, 'shipment movements');

  const status = clean(only(summary, 'span#Son_Durum', 'shipment summary').text(), 120);
  const deliveredText = clean(only(summary, 'span#Teslim_Tarihi', 'shipment summary').text(), 40);
  const branch = clean(only(summary, 'span#varis_subesi', 'shipment summary').text(), 80);
  const plannedText = clean(only(summary, 'span#planlanan_teslim_tarihi', 'shipment summary').text(), 40);

  const scans: Scan[] = [];
  const seen = new Set<string>();
  // Within a day, rows dated by the day (order 1) follow the clocked movements (0), and the delivery (2) ends it.
  const add = (local: string, description: string, location: string, order: number) => {
    const event: CarrierEvent = { local_time: local, description, ...(location ? { location } : {}) };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    const stage = arasStage(description);
    if (stage) Object.assign(event, { stage, stage_source: 'carrier_map' });
    scans.push({ event, local, order });
  };

  for (const [time, province, unit, description] of grid(movements, 'transactionsDataGrid', MOVEMENT_HEADER, 'vehicle movements')) {
    const local = wallClock(time!, 'second');
    if (!local || !description) throw new SchemaError(PROVIDER, 'Aras Kargo returned an invalid movement');
    add(local, description, place(unit!, province!), 0);
  }
  // A redirection's reason follows its state in brackets.
  for (const [date, , state, from, , cause] of grid(movements, 'redirectionDataGrid', REDIRECTION_HEADER, 'redirections')) {
    const day = wallClock(date!, 'day');
    if (!day || !state) throw new SchemaError(PROVIDER, 'Aras Kargo returned an invalid redirection');
    const reason = cause!.replace(/[()]/g, '').trim();
    add(day, reason ? `${state} (${reason})` : state, from!, 1);
  }
  // The third cell is the courier's free-text note.
  for (const [date, reason] of grid(summary, 'notDeliveredDataGrid', NON_DELIVERY_HEADER, 'failed deliveries')) {
    const day = wallClock(date!, 'day');
    if (!day || !reason) throw new SchemaError(PROVIDER, 'Aras Kargo returned an invalid failed delivery');
    add(day, reason, '', 1);
  }
  if (deliveredText) {
    const local = wallClock(deliveredText, 'minute');
    if (!local || !status) throw new SchemaError(PROVIDER, 'Aras Kargo returned an invalid delivery time');
    add(local, status, branch, 2);
  }

  // Newest first. The movement list comes sorted as text, not by time.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const day = (scan: Scan) => scan.local.slice(0, 10);
  scans.sort((left, right) => day(left) !== day(right) ? (day(left) < day(right) ? 1 : -1)
    : left.order !== right.order ? right.order - left.order
      : left.local < right.local ? 1 : left.local > right.local ? -1 : 0);
  const events = scans.map(({ event }) => event);
  const newest = events[0];
  const newestDay = scans[0] ? day(scans[0]) : null;
  if (!status && !newest) throw new NoHistoryError(PROVIDER);

  // The current status settles a delivery. Otherwise a failed delivery after
  // the last movement is the parcel's news, though the status still has it
  // at the delivery branch.
  const current = status ? arasStage(status) : newest!.stage as Stage | undefined;
  const failed = current !== 'delivered' && newest?.stage === 'failed_attempt';
  const stage = failed ? 'failed_attempt' : current;
  const text = failed ? newest.description! : status || newest!.description!;

  // The planned day is an estimate: it goes once the parcel stops moving or the day is behind its news.
  const planned = wallClock(plannedText, 'day');
  const expected = stage && MOVING.has(stage) && planned && (!newestDay || planned >= newestDay) ? planned : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: text,
    last_update: null,
    ...(scans[0] ? { last_update_local: scans[0].local } : {}),
    expected_delivery: expected,
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
  };
}
