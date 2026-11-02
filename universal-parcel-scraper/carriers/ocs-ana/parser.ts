import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ocsStage } from './status.js';

export const PROVIDER = 'OCS';
export const CARRIER = 'ocs-ana';
/** The lookup the tracking form on OCS's site opens, which sends each number on to where it is tracked. */
export const OCS_LOOKUP = 'https://www2.ocsworldwide.net/ExpTracking/cwbCheck.php';
/** The history page the lookup sends OCS waybills to. */
export const OCS_HISTORY = 'https://webcsw.ocs.co.jp/csw/ECSWG0201R00003P.do';
// The lookup's reply is one line; a history page with sixteen scans is about 45 kB.
export const OCS_LOOKUP_MAX_BYTES = 64 * 1024;
export const OCS_MAX_BYTES = 1024 * 1024;
// The history page's own check: eleven or twelve half-width digits.
const NUMBER = /^\d{11,12}$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
const REFRESH = /<meta\s+http-equiv\s*=\s*["']?refresh["']?\s+content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*([^"']*)["']/i;
// The page the lookup once put between a waybill and Yamato's tracker, with the
// partner's tracker in `COUrl` and its number in `VNo`.
const INTRO = /^\/ExpTracking\/intro\w*\.php$/i;
const NOT_FOUND = /^(?:No items were found for the search condition\.?|条件に一致する情報がありません。?)$/;
const SUMMARY = 'Air Waybill No.|Latest Tracking Record|Shipper|Receiver|Pcs|Actual Weight|Vol. Weight';
const DETAIL = 'Air Waybill No.|Shipper|Receiver|Type|Pcs|Actual Weight|Vol. Weight';
const HISTORY = 'Activity|Date/Time|Location|Memo';
// "Fri 13Mar2026 12:07", the scan's wall clock to the minute.
const CLOCK = /^(?:[A-Z][a-z]{2}\s+)?(\d{2}[A-Z][a-z]{2}\d{4}\s\d{2}:\d{2})$/;
const WEIGHT = /^(\d{1,5}(?:\.\d{1,3})?)\s*kg$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** The Japanese delivery companies the lookup hands waybills to, by their trackers' hosts and number parameters. */
const PARTNERS = [
  { carrier: 'sagawa', name: 'Sagawa Express', host: /(?:^|\.)sagawa-exp\.co\.jp$/, params: ['oku01', 'okurijoNo'], number: /^(?:\d{10}|\d{12})$/ },
  { carrier: 'yamato', name: 'Yamato Transport', host: /(?:^|\.)kuronekoyamato\.co\.jp$/, params: ['number01', 'no01'], number: /^\d{12}$/ },
] as const;

export type OcsHandoff = Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>;

/** An OCS waybill, eleven or twelve digits; anything else is not one OCS issues. */
export function normalizeOcsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'OCS waybills are eleven or twelve digits');
  return number;
}

/** The delivery company whose tracker an address opens, with the number it names, or nothing. */
function partner(address: string | null, named?: string | null): OcsHandoff {
  let url: URL;
  try {
    url = new URL(address ?? '');
  } catch {
    return {};
  }
  const known = PARTNERS.find((item) => item.host.test(url.hostname));
  if (!known) return {};
  const value = named ?? known.params.map((param) => url.searchParams.get(param)).find(Boolean) ?? '';
  const number = normalizeTrackingNumber(value);
  return known.number.test(number) ? { delivery_carrier: known.carrier, delivery_tracking_number: number } : {};
}

/**
 * Where the lookup sends one waybill, from the refresh its reply holds: OCS's
 * history page, with no partner, or a Japanese delivery company's tracker, with
 * that company and the number it names. Another destination names no partner.
 */
export function ocsRoute(html: string, raw: string): OcsHandoff {
  const number = normalizeOcsNumber(raw);
  const match = REFRESH.exec(html.slice(0, 16_000));
  if (!match) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OCS answered with a browser check');
    throw new SchemaError(PROVIDER, 'OCS returned a lookup reply without its destination');
  }
  let target: URL;
  try {
    target = new URL(match[1]!.trim().replace(/&amp;/gi, '&'), OCS_LOOKUP);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'OCS returned an invalid lookup destination', { cause });
  }
  const history = new URL(OCS_HISTORY);
  if (target.hostname === history.hostname && target.pathname === history.pathname) {
    if (target.searchParams.get('cwbno') !== number) throw new IndeterminateError(PROVIDER, 'OCS sent the lookup to another waybill');
    return {};
  }
  if (target.hostname === new URL(OCS_LOOKUP).hostname && INTRO.test(target.pathname)) {
    if (normalizeTrackingNumber(target.searchParams.get('Cwbno') ?? '') !== number) {
      throw new IndeterminateError(PROVIDER, 'OCS sent the lookup to another waybill');
    }
    return partner(target.searchParams.get('COUrl'), target.searchParams.get('VNo') ?? '');
  }
  return partner(target.href);
}

/** A cell's text: the value of its read-only field, where the page puts it, else its own text. */
function cellText($: CheerioAPI, cell: AnyNode, maxLength = 300): string {
  const field = $(cell).find('input');
  return clean(field.length ? field.first().attr('value') ?? '' : $(cell).text(), maxLength);
}

/** The cells of a table's header row, the first row of its first body. */
function header($: CheerioAPI, table: AnyNode): string {
  return $(table).children('tbody').first().children('tr').first().children('td, th')
    .map((_, cell) => clean($(cell).text(), 60)).get().join('|');
}

/** The rows of a table's records, its second body. */
function records($: CheerioAPI, table: AnyNode) {
  return $(table).children('tbody').eq(1).children('tr');
}

/** A scan's wall clock, to the minute, with no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // Read in UTC to check the calendar alone: a day or time that does not exist is refused.
  const parsed = match ? DateTime.fromFormat(match[1]!, 'ddLLLyyyy HH:mm', { zone: 'UTC', locale: 'en-US' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'OCS returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

// A run of eight or more digits, with spaces, brackets, dots or hyphens between
// them: a phone number, or the delivery company's slip number that its delivery
// memo runs into ("Delivery Completed123456789012, Delivered").
const DIGITS = /\+?\d(?:[\s().-]{0,2}\d){7,}/g;
// Who took the shipment, should a memo name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed|received)\s+(?:for\s+)?by\b[\s\S]*$/i;

/**
 * A scan's wording: the activity, then the memo after a colon when it adds
 * something, as "Arrived at Facility: Arrived at Service Center". The memo loses
 * long digit runs and a clause naming who took the shipment.
 */
export function ocsWording(activity: string, memo: string): string {
  const note = clean(memo.replace(RECEIVER, '').replace(DIGITS, '')).replace(/\s+([,;.])/g, '$1').replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  if (!activity) return note;
  return note && note.toLowerCase() !== activity.toLowerCase() ? `${activity}: ${note}` : activity;
}

/** The weight the page writes as "0.9kg"; none for a blank or zero one. */
function weight(text: string): number | null {
  const match = WEIGHT.exec(text);
  const kilograms = match ? Number(match[1]) : 0;
  return kilograms > 0 ? kilograms : null;
}

/** The country of the receiver's place, written "CITY/COUNTRY"; the city is not kept. */
function destination(place: string): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = clean(place.includes('/') ? place.slice(place.lastIndexOf('/') + 1) : '', 60);
  if (!name) return {};
  const code = countryCode(name);
  return code ? { destination_country: code } : { destination_country_name: name };
}

/** A waybill the lookup hands to a delivery company and OCS's page does not hold. */
function handedOff(handoff: OcsHandoff): CarrierResult {
  const name = PARTNERS.find((item) => item.carrier === handoff.delivery_carrier)!.name;
  return { status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
    last_status_text: `Handed over to ${name}`, last_update: null, expected_delivery: null, ...handoff, summary_only: true, events: [] };
}

/**
 * The history page for one waybill, in English. A summary row and a detail
 * table echo the waybill with its shipper's and receiver's places, its pieces
 * and weights, and the history lists the scans newest first: the activity, a
 * wall clock, OCS's station and a memo. A waybill the page does not hold is a
 * message over an empty table. `handoff` is the delivery company the lookup
 * names for the waybill, if any.
 */
export function parseOcs(html: string, raw: string, handoff: OcsHandoff = {}): CarrierResult {
  const number = normalizeOcsNumber(raw);
  const $ = load(html);
  if ($('form[name="PCSWG0201RForm"]').length !== 1 || $('#error_msg').length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OCS answered with a browser check');
    throw new SchemaError(PROVIDER, 'OCS returned a page without a tracking answer');
  }
  const messages = $('#error_msg li').map((_, item) => clean($(item).text(), 200)).get().filter(Boolean);
  if (messages.length) {
    if (!messages.every((message) => NOT_FOUND.test(message))) throw new IndeterminateError(PROVIDER, 'OCS did not complete the lookup');
    if (handoff.delivery_carrier) return handedOff(handoff);
    throw new NotFoundError(PROVIDER);
  }
  const tables = $('table').toArray();
  const of = (kind: string) => tables.filter((table) => header($, table) === kind);
  const [summary, ...more] = of(SUMMARY);
  if (!summary || more.length) throw new SchemaError(PROVIDER, 'OCS returned a page without its summary');
  const listed = records($, summary);
  if (listed.length > 1) throw new IndeterminateError(PROVIDER, 'OCS listed several shipments for this waybill');
  if (listed.length !== 1) throw new SchemaError(PROVIDER, 'OCS returned a summary without its shipment');
  if (normalizeTrackingNumber(clean(listed.children('td').first().text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'OCS answered for another waybill');
  }
  const details = of(DETAIL);
  const histories = of(HISTORY);
  if (details.length !== 1 || histories.length !== 1) throw new SchemaError(PROVIDER, 'OCS returned a shipment without its history');
  const facts = records($, details[0]!).first().children('td').toArray();
  if (facts.length !== 7) throw new SchemaError(PROVIDER, 'OCS returned invalid shipment details');
  if (normalizeTrackingNumber(clean($(facts[0]).text(), 64)) !== number) throw new IndeterminateError(PROVIDER, 'OCS answered for another waybill');
  const rows = records($, histories[0]!);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'OCS returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, row) => {
    const cells = $(row).children('td').toArray();
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'OCS returned an invalid scan row');
    const local = wallClock(clean($(cells[1]).text(), 60));
    const description = ocsWording(cellText($, cells[0]!, 120), cellText($, cells[3]!));
    if (!description) throw new SchemaError(PROVIDER, 'OCS returned a scan without wording');
    // "TOKYO SKYGATE / JAPAN": OCS's station, then its country.
    const location = cellText($, cells[2]!, 120).replace(/\s*\/\s*/g, ', ');
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = ocsStage(description);
    events.push({ local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  });
  if (!events.length) {
    if (handoff.delivery_carrier) return handedOff(handoff);
    throw new NoHistoryError(PROVIDER);
  }

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const kilograms = weight(cellText($, facts[5]!, 20));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(kilograms !== null ? { weight_kg: kilograms } : {}),
    ...destination(cellText($, facts[2]!, 120)),
    ...handoff,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
