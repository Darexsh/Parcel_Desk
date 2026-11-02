import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { intexStage } from './status.js';

export const PROVIDER = 'INTEX Paketdienst';
// A long history is a few kilobytes.
export const INTEX_MAX_BYTES = 256 * 1024;

const ZONE = 'Europe/Berlin';
// Seven digits and a final one, which the tracker shows after a hyphen.
const NUMBER = /^\d{8}$/;
// "12.05.2026 um 14:33 Uhr": the wall clock in Germany, to the minute.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) um (\d{2}):(\d{2}) Uhr$/;
const NUMBER_LABEL = 'Ihre Sendung Nr.';
const DESTINATION_LABEL = 'nach PLZ/Ort';
// "D-12345 Musterstadt": the recipient's country, postcode and town.
const GERMANY = /^D-\d{5}(?:\s|$)/;
// "Eine Sendung mit der Nummer: … konnte nicht ermittelt werden!", with the number as sent.
const NOT_FOUND = /^Eine Sendung mit der Nummer:\s*(\S{1,64})\s*konnte nicht ermittelt werden!/;
// Bot checks a firewall or CDN could put in place of the page.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|captcha-delivery/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;

/** The eight digits of an INTEX shipment number, typed with or without its hyphen; anything else is not one INTEX issues. */
export function normalizeIntexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'INTEX shipment numbers are seven digits, a hyphen and one digit');
  return number;
}

/** The number as the tracker shows it, with the hyphen before its last digit. */
export function intexRequestNumber(raw: string): string {
  const number = normalizeIntexNumber(raw);
  return `${number.slice(0, 7)}-${number.slice(7)}`;
}

/** Whether a number the page shows is the whole number asked, hyphen or not. */
function sameNumber(shown: string, number: string): boolean {
  return /^\d{7}-?\d$/.test(shown) && shown.replace('-', '') === number;
}

interface Row {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

function rowOf(wording: string, clock: string, index: number): Row {
  const match = CLOCK.exec(clock);
  const at = match ? firstOccurrence(DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: ZONE })) : null;
  const description = clean(wording, 300);
  if (!at?.isValid || !description) throw new SchemaError(PROVIDER, 'INTEX returned an invalid scan');
  const staged = intexStage(description);
  return {
    index,
    timestamp: at.toMillis(),
    event: {
      time: at.toISO({ suppressMilliseconds: true }),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

interface Shipment {
  fields: Map<string, string>;
  rows: Row[];
}

/**
 * The shipment table: label and value headings for the number and the
 * destination, then one row per scan, oldest first. Rows spanning both
 * columns hold rules and buttons.
 */
function shipmentOf($: CheerioAPI): Shipment {
  const fields = new Map<string, string>();
  const rows: Row[] = [];
  $('table.shipment_data').find('tr').each((_, tr) => {
    const headings = $(tr).children('th').toArray().map((th) => clean($(th).text(), 120));
    const cells = $(tr).children('td');
    if (headings.length === 2 && !cells.length) {
      if (fields.has(headings[0]!)) throw new SchemaError(PROVIDER, 'INTEX returned a field twice');
      fields.set(headings[0]!, headings[1]!);
    } else if (!headings.length && cells.length === 2) {
      if (rows.length >= MAX_ROWS) throw new SchemaError(PROVIDER, 'INTEX returned too many scans');
      rows.push(rowOf($(cells[0]).text(), clean($(cells[1]).text(), 60), rows.length));
    } else if (headings.length || cells.length !== 1 || cells.attr('colspan') !== '2') {
      throw new SchemaError(PROVIDER, 'INTEX returned a shipment row without its fields');
    }
  });
  return { fields, rows };
}

/**
 * The page INTEX's tracker at intex-paketdienst.de/sendungsstatus renders for
 * one shipment number. A shipment must be the only one on the page and name
 * the whole number asked; the not-found notice must name it too. The
 * recipient's postcode and town are never read.
 */
export function parseIntex(html: string, raw: string): CarrierResult {
  const number = normalizeIntexNumber(raw);
  const $ = load(html);
  const tables = $('table.shipment_data');
  if (!tables.length) {
    const absent = NOT_FOUND.exec(clean($('#content').first().text(), 600));
    if (absent) {
      if (!sameNumber(absent[1]!, number)) throw new IndeterminateError(PROVIDER, 'INTEX answered for another number');
      throw new NotFoundError(PROVIDER);
    }
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'INTEX answered with a browser check');
    throw new SchemaError(PROVIDER, 'INTEX did not return its tracking page');
  }
  // A lookup that lists several shipments has not settled on the one asked.
  if (tables.length > 1) throw new IndeterminateError(PROVIDER, 'INTEX listed several shipments');
  const { fields, rows } = shipmentOf($);
  const shown = fields.get(NUMBER_LABEL);
  if (!shown) throw new SchemaError(PROVIDER, 'INTEX returned a shipment without its number');
  if (!sameNumber(shown, number)) throw new IndeterminateError(PROVIDER, 'INTEX answered for another shipment');

  // Newest first; scans in the same minute keep the page's order, reversed.
  rows.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const seen = new Set<string>();
  const events = rows.map(({ event }) => event).filter((event) => {
    const identity = JSON.stringify([event.time, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned!.time : undefined;
  const germany = GERMANY.test(fields.get(DESTINATION_LABEL) ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(germany ? { destination_country: 'DE' } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
