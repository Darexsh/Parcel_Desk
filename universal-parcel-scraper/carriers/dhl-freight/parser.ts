import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { dhlFreightStage } from './status.js';

export const PROVIDER = 'DHL Freight';
// A delivered consignment's page is about 50 kB.
export const DHL_FREIGHT_MAX_BYTES = 1024 * 1024;

// An order code: the terminal's three letters, the product's two and seven
// digits, typed with or without its hyphens.
const ORDER_CODE = /^([A-Z]{3})([A-Z]{2})(\d{7})$/;
// Consignment IDs: nine digits, or eleven for a domestic consignment.
const CONSIGNMENT_ID = /^(?:\d{9}|\d{11})$/;
// Package IDs: DHL's licence plates, or an SSCC with or without its `00`.
const LICENCE_PLATE = /^JND\d{17}$/;
const SSCC = /^(?:00)?(\d{18})$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?$/;
// A terminal is its country's code and its town, as `DE-KOBLENZ`.
const TERMINAL = /^([A-Z]{2})-(\S.*)$/;
// The consignee's place is its country's code and its town, as `DE - KOBLENZ`.
const PLACE = /^([A-Z]{2}) - \S/;
// English weights group thousands with commas: `1,112`.
const WEIGHT = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?$/;
const NOT_FOUND = 'There is no consignment matching your search criteria.';
// Bot checks a firewall could serve in place of the page: F5's rejection and
// its JavaScript challenge, and other vendors' interstitials.
const CHALLENGE = /<title>\s*Request Rejected|The requested URL was rejected|\/TSPD\/|window\["bobcmn"\]|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|_Incapsula_Resource/i;
const MAX_ROWS = 300;

/** How ActiveTracing is asked for a number: the order code and consignment ID field, or the package field. */
export interface DhlFreightQuery {
  /** The number in its comparable form: an order code without hyphens, an SSCC with its `00`. */
  readonly number: string;
  readonly field: 'consignment' | 'package';
  /** The text sent: an order code with its hyphens. */
  readonly value: string;
}

/** The query for a number DHL Freight issues; anything else is not one of its numbers. */
export function dhlFreightQuery(raw: string): DhlFreightQuery {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const order = ORDER_CODE.exec(number);
  if (order) return { number, field: 'consignment', value: `${order[1]}-${order[2]}-${order[3]}` };
  if (CONSIGNMENT_ID.test(number)) return { number, field: 'consignment', value: number };
  if (LICENCE_PLATE.test(number)) return { number, field: 'package', value: number };
  const sscc = SSCC.exec(number)?.[1];
  if (sscc && hasGs1CheckDigit(sscc)) return { number: `00${sscc}`, field: 'package', value: `00${sscc}` };
  throw new InvalidInputError(PROVIDER, 'DHL Freight tracks order codes, consignment IDs and package IDs');
}

/** An identifier in the form queries compare: no hyphens or spaces, an SSCC with its `00`. */
function comparable(value: string): string {
  const number = normalizeTrackingNumber(value);
  return /^\d{18}$/.test(number) ? `00${number}` : number;
}

/** The consignment details' labels and their values, as the general tab lists them. */
function details($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  $('#general td.lbl').each((_, cell) => {
    const label = clean($(cell).text(), 80).toLowerCase();
    if (label && !fields.has(label)) fields.set(label, clean($(cell).next('td').text(), 200));
  });
  return fields;
}

/** Every identifier the page gives the consignment: its IDs, order code and packages. */
function identifiers($: CheerioAPI, fields: Map<string, string>): Set<string> {
  const values = [...fields].filter(([label]) => /consignment id|order code|package id/.test(label))
    .flatMap(([, value]) => value.split('|'));
  values.push(...$('select[name="packageId"] option').toArray().map((option) => $(option).attr('value') ?? ''));
  return new Set(values.map((value) => comparable(clean(value, 64))).filter(Boolean));
}

/**
 * A row's clock: the terminal's wall clock to the minute, or only its day.
 * The page names no zone, so either stays local.
 */
function clockOf(text: string): string {
  const match = DAY.exec(text);
  const [, day, month, year, hour, minute] = match ?? [];
  const parsed = match ? DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day),
    hour: Number(hour ?? 0), minute: Number(minute ?? 0) }, { zone: 'UTC' }) : null;
  // Luxon rejects a day or minute past the calendar's, but takes 24:00 for the next midnight.
  if (!parsed?.isValid || Number(hour) > 23) throw new SchemaError(PROVIDER, 'DHL Freight returned an invalid scan date');
  return hour === undefined ? parsed.toFormat('yyyy-MM-dd') : parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** A terminal as `KOBLENZ, DE`; a row for a delivery names none. */
function locationOf(text: string): string | undefined {
  const terminal = TERMINAL.exec(text);
  if (terminal && countryCode(terminal[1])) return `${terminal[2]!.trim()}, ${terminal[1]}`;
  return text || undefined;
}

/** The consignment's history, oldest first as the page lists it. */
function rowsOf($: CheerioAPI): CarrierEvent[] {
  const rows = $('#sendungsHistorieOne tr').filter((_, row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DHL Freight returned too many scans');
  return rows.toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'DHL Freight returned a scan without its fields');
    const description = clean(cells.eq(1).text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'DHL Freight returned a scan without its status');
    const location = locationOf(clean(cells.eq(2).text(), 120));
    const staged = dhlFreightStage(description);
    return { local_time: clockOf(clean(cells.eq(3).text(), 40)), description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
}

/** The gross weight in kilograms, as the English page writes it. */
function weightOf(fields: Map<string, string>): number | undefined {
  const value = fields.get('gross weight (kg)') ?? '';
  const weight = WEIGHT.test(value) ? Number(value.replaceAll(',', '')) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 ? weight : undefined;
}

/** The country of the consignee's place; the town stays out. */
function destinationOf(fields: Map<string, string>): string | undefined {
  const place = fields.get('consignee location') ?? '';
  return PLACE.test(place) ? countryCode(place.slice(0, 2)) ?? undefined : undefined;
}

/** The search page's answer: a notice that nothing matched the number it repeats in its field. */
function absence($: CheerioAPI, query: DhlFreightQuery): never {
  const field = query.field === 'package' ? 'valuePackageField' : 'valueComboField';
  const echoed = clean($(`input[name="${field}"]`).first().attr('value'), 64);
  const notices = $('div.wrn').toArray().map((notice) => clean($(notice).text(), 200)).filter(Boolean);
  if (!notices.includes(NOT_FOUND)) throw new IndeterminateError(PROVIDER, 'DHL Freight did not complete the search');
  if (comparable(echoed) !== query.number) throw new IndeterminateError(PROVIDER, 'DHL Freight answered for another number');
  throw new NotFoundError(PROVIDER);
}

/**
 * ActiveTracing's English page for one search. A match opens the
 * consignment's details: its summary and its history, oldest first, each row
 * with a status, the terminal and the terminal's date and time. The page must
 * list the number asked among the consignment's IDs, order code or packages.
 * An unknown number keeps the search page, with a notice under the field it
 * was typed in. The consignee's town, the references, the volume and the
 * package scans are never read.
 */
export function parseDhlFreight(html: string, query: DhlFreightQuery): CarrierResult {
  const $ = load(html);
  const history = $('#sendungsHistorieOne');
  if (history.length !== 1) {
    // Only the search page has the package field; the details page keeps the quick search alone.
    if ($('form[name="datSelectionForm"] input[name="valuePackageField"]').length) absence($, query);
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DHL Freight answered with a browser check');
    throw new SchemaError(PROVIDER, 'DHL Freight returned an unexpected page');
  }
  const fields = details($);
  if (!identifiers($, fields).has(query.number)) throw new IndeterminateError(PROVIDER, 'DHL Freight answered for another consignment');

  const rows = rowsOf($);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // The page lists the oldest row first; a day-only row sits among the timed rows of its day.
  const oldestFirst = (rows[0]!.local_time as string).slice(0, 10) <= (rows.at(-1)!.local_time as string).slice(0, 10);
  const seen = new Set<string>();
  const events = (oldestFirst ? rows.reverse() : rows).filter((event) => {
    const identity = JSON.stringify([event.local_time, event.description, event.location ?? null]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = fields.get('product');
  const weight = weightOf(fields);
  const destination = destinationOf(fields);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
