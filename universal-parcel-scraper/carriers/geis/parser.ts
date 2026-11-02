import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { geisQuiet, geisStage } from './status.js';

export const PROVIDER = 'Geis';

// Consignment numbers are thirteen digits. A label's barcode adds the piece's
// two-digit position and a check digit.
const SHIPMENT = /^\d{13}$/;
const BARCODE = /^\d{16}$/;
const FOUND = /^Shipment No\. (\S+)$/;
const ABSENT = /^The shipment no\. (\S+) was not found or was not handed over for transportation\.$/;
const CODE = /^[A-Z0-9]{1,6}$/;
const DAY = /^(\d{2})\. (\d{2})\. (\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
// A partner's scan can name its country before the town, as "DE Musterstadt".
const PREFIXED = /^([A-Z]{2}) (\S.*)$/;
const WEIGHT = /^(\d{1,6}(?:[.,]\d{1,3})?) ?kg$/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;

/**
 * The consignment number Geis's tracker looks up: thirteen digits, or the
 * consignment inside a label's sixteen-digit barcode, whose check digit must
 * pass.
 */
export function geisShipmentNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (SHIPMENT.test(number)) return number;
  if (BARCODE.test(number) && hasGs1CheckDigit(number)) return number.slice(0, 13);
  throw new InvalidInputError(PROVIDER, 'Geis tracks thirteen-digit consignment numbers');
}

interface Row {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

/** The page's text without its line breaks, so a notice reads as one sentence. */
function textOf($: CheerioAPI, selector: string): string[] {
  return $(selector).toArray().map(node => {
    const copy = $(node).clone();
    copy.find('br').replaceWith(' ');
    return clean(copy.text(), 300);
  });
}

/**
 * When a scan happened. Each row carries its clock with an offset. Geis's own
 * scans are instants, but a partner's can be its wall clock under the
 * offset of Geis's servers. A clock is kept as an instant when the offset is
 * the one the row's country keeps at that wall time, so either reading gives
 * the same instant; otherwise, and on rows without a country, it stays a wall
 * clock.
 */
function clockOf(apidate: string, day: string, time: string, country: string | null): { at: Pick<CarrierEvent, 'time'> & { local_time?: string }; timestamp: number } {
  if (apidate) {
    const labelled = EXPLICIT_OFFSET_PATTERN.test(apidate) ? DateTime.fromISO(apidate, { setZone: true }) : null;
    if (!labelled?.isValid) throw new SchemaError(PROVIDER, 'Geis returned an invalid scan time');
    const whole = labelled.startOf('second');
    const wall = whole.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const zone = country ? countryTimeZone(country) : null;
    const local = zone ? firstOccurrence(DateTime.fromISO(wall, { zone })) : null;
    const at = local?.isValid && local.offset === whole.offset ? { time: whole.toISO({ suppressMilliseconds: true }) } : { local_time: wall };
    return { at, timestamp: whole.toMillis() };
  }
  // A row without its clock attribute keeps the date and minute the page prints.
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const parsed = date && clock ? DateTime.fromObject({ year: Number(date[3]), month: Number(date[2]), day: Number(date[1]),
    hour: Number(clock[1]), minute: Number(clock[2]) }, { zone: 'UTC' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Geis returned an invalid scan time');
  return { at: { local_time: parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") }, timestamp: parsed.toMillis() };
}

/** A row's town and country code, from its columns or a town that names its country first. */
function placeOf(countryName: string, town: string): { country: string | null; location?: string } {
  let country = countryName ? countryCode(countryName) : null;
  let place = town;
  const prefixed = PREFIXED.exec(town);
  if (!countryName && prefixed && countryCode(prefixed[1])) {
    country = countryCode(prefixed[1]);
    place = prefixed[2]!.trim();
  }
  const location = place ? (country ? `${place}, ${country}` : countryName ? `${place}, ${countryName}` : place)
    : countryName || undefined;
  return { country, ...(location ? { location } : {}) };
}

/** The history table's rows, newest first as the page lists them. */
function rowsOf($: CheerioAPI): Row[] {
  const rows: Row[] = [];
  const history = $('section.trace2 tr').filter((_, tr) => $(tr).children('td[data-code]').length > 0);
  if (history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Geis returned too many scans');
  history.each((index, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== 5) throw new SchemaError(PROVIDER, 'Geis returned a scan without its fields');
    const status = cells.eq(4);
    const code = clean(status.attr('data-code'), 10);
    const description = clean(status.text(), 300);
    if ((code && !CODE.test(code)) || !description) throw new SchemaError(PROVIDER, 'Geis returned a scan without its status');
    const { country, location } = placeOf(clean(cells.eq(2).text(), 80), clean(cells.eq(3).text(), 120));
    const { at, timestamp } = clockOf(clean($(tr).attr('data-apidate'), 64), clean(cells.eq(0).text(), 20), clean(cells.eq(1).text(), 10), country);
    const stage = code ? geisStage(code) : undefined;
    rows.push({ index, timestamp, event: { ...at, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } });
  });
  return rows;
}

/** The summary's total weight, when it reads as kilograms. */
function weightOf($: CheerioAPI): number | undefined {
  const cell = $('.trace22 tr').filter((_, tr) => clean($(tr).children('th').text(), 40) === 'Total weight').children('td').first();
  const match = WEIGHT.exec(clean(cell.text(), 20));
  const weight = match ? Number(match[1]!.replace(',', '.')) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 ? weight : undefined;
}

/**
 * The English tracking page for one consignment: its status history, newest
 * first, each row with a date, a time, a country, a place and a status number.
 * The heading names the consignment the page looked up; an unknown one gets
 * a notice naming it instead. The progress rail, the pieces' references, the
 * category and the person who took delivery are never read.
 */
export function parseGeis(html: string, shipment: string): CarrierResult {
  const $ = load(html);
  const headings = textOf($, '.karieraheadline h2');
  if (headings.length !== 1) throw new IndeterminateError(PROVIDER, 'Geis did not return its tracking page');
  const absent = ABSENT.exec(headings[0]!);
  const found = FOUND.exec(headings[0]!);
  const named = absent?.[1] ?? found?.[1];
  if (named === undefined) throw new IndeterminateError(PROVIDER, 'Geis did not return its tracking page');
  if (named !== shipment) throw new SchemaError(PROVIDER, 'Geis answered for a different consignment');
  const rows = rowsOf($);
  if (absent) {
    if (rows.length) throw new SchemaError(PROVIDER, 'Geis returned a history under its not-found notice');
    throw new NotFoundError(PROVIDER);
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first; rows with one clock keep the page's order.
  rows.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const seen = new Set<string>();
  const events = rows.map(({ event }) => event).filter(event => {
    const identity = JSON.stringify([event.time ?? event.local_time, event.provider_code ?? null, event.description, event.location ?? null]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const newest = events[0]!;
  // A note or a partial delivery keeps the stage of the status before it.
  const current = events.find(event => !geisQuiet(event.provider_code ?? ''));
  const stage = current?.stage as Stage | undefined;
  const weight = weightOf($);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current?.time ? { delivered_at: current.time } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
