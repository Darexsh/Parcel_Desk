import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { teamGlobalExpressMilestoneStage, teamGlobalExpressStage } from './status.js';

export const PROVIDER = 'Team Global Express';
/** The quick search MyTeamGE's track box sends; it answers an HTML fragment of matching shipments. */
export const TGE_SEARCH = 'https://www.myteamge.com/search-shipment';
/** The shipment page a search result opens, keyed by the id the search gives it. */
export const TGE_DETAILS = 'https://www.myteamge.com/web/guest/shipment-details';
// A one-shipment answer is about 6 kB.
export const TGE_SEARCH_MAX_BYTES = 512 * 1024;
// A shipment page is about 400 kB, most of it the portal's own script and markup.
export const TGE_DETAILS_MAX_BYTES = 4 * 1024 * 1024;
// Letters and digits with at least one digit; the track box takes three to fifty characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// The id a result row opens its shipment page with.
const SHIPMENT_ID = /^[A-Za-z0-9]{16,128}$/;
const CLOCK = /^\d{2}-\d{2}-\d{4} \d{2}:\d{2} [AP]M$/;
const ETA = /^\d{2}\/\d{2}\/\d{4}$/;
const WEIGHT = /^\d{0,6}(?:\.\d{1,3})?$/;
// Bot checks AWS's firewall or CloudFront could put in place of a reply.
const CHALLENGE = /AwsWafIntegration|awswaf\.com|gokuProps|captcha-sdk|<title>\s*(?:ERROR: The request could not be satisfied|Request blocked|403 Forbidden)/i;
// Where a scan's location is a system or a desk, not a place.
const NO_PLACE = /^(?:IN SYSTEM|SERVICE ALERT APPROVAL)$/i;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;

/** A number for MyTeamGE's search, in capitals; anything else is not one Team Global Express issues. */
export function normalizeTeamGlobalExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Team Global Express numbers are four to forty letters and digits');
  return number;
}

/** The quick search for one number, with the fields MyTeamGE's track box sends. */
export function teamGlobalExpressSearchUrl(number: string): string {
  const url = new URL(TGE_SEARCH);
  for (const [key, value] of [
    ['p_p_id', 'searchportlet_WAR_searchportlet'], ['p_p_lifecycle', '2'], ['p_p_state', 'normal'], ['p_p_mode', 'view'],
    ['p_p_resource_id', 'quickSearch'], ['p_p_cacheability', 'cacheLevelPage'], ['company', number],
    ['_searchportlet_WAR_searchportlet_shipmentReferences', number], ['_searchportlet_WAR_searchportlet_externalSearchQuery', ''],
  ]) url.searchParams.set(key!, value!);
  return url.toString();
}

/** The shipment page for the id a search result row carries. */
export function teamGlobalExpressDetailsUrl(id: string): string {
  if (!SHIPMENT_ID.test(id)) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid shipment id');
  const url = new URL(TGE_DETAILS);
  url.searchParams.set('consignmentId', id);
  return url.toString();
}

/** A page without what MyTeamGE's own page has: a browser check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Team Global Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The shipment a search found for the number: the id its page opens with, and its own number. */
export interface TeamGlobalExpressMatch {
  id: string;
  shipment: string;
}

const own = (value: string) => normalizeTrackingNumber(clean(value, 80)).toUpperCase();

/**
 * The quick search's answer for one number. It heads the rows with the term
 * it searched and how many shipments matched, and says so when none did. A
 * row counts when its shipment number is the number asked, else when its
 * references name it; the search also matches other references and card
 * numbers that a row does not show.
 */
export function parseTeamGlobalExpressSearch(html: string, raw: string): TeamGlobalExpressMatch {
  const number = normalizeTeamGlobalExpressNumber(raw);
  const $ = load(html);
  const table = $('#quickSearchTableResult');
  if (table.length !== 1) unexpected(html, 'Team Global Express returned a search reply without its results');
  const headers = table.find('tr.grid-row-header').filter((_, row) => $(row).find('span.srch-term').length > 0);
  if (headers.length !== 1) throw new SchemaError(PROVIDER, 'Team Global Express returned a search reply without its term');
  if (own(headers.find('span.srch-term').first().text()) !== number) {
    throw new IndeterminateError(PROVIDER, 'Team Global Express answered for another search');
  }
  const count = /^(\d{1,4}) shipments?$/.exec(clean(headers.find('b').first().text(), 40));
  if (!count) throw new SchemaError(PROVIDER, 'Team Global Express returned a search reply without its count');
  const rows = table.find('tr.data-row').map((_, row) => ({
    id: clean($(row).attr('data-refnum'), 200),
    shipment: own($(row).find('span.shipNo').first().text()),
    references: $(row).find('td.senderRef span.block-spn').map((__, reference) => own($(reference).text())).get(),
  })).get();
  if (count[1] === '0') {
    if (rows.length || table.find('.no-res-found').length !== 1) throw new SchemaError(PROVIDER, 'Team Global Express returned an inconsistent search reply');
    throw new NotFoundError(PROVIDER);
  }
  if (!rows.length) throw new SchemaError(PROVIDER, 'Team Global Express returned a search reply without its shipments');
  if (rows.some((row) => !row.shipment)) throw new SchemaError(PROVIDER, 'Team Global Express returned a shipment without its number');
  const named = rows.filter((row) => row.shipment === number);
  const referenced = named.length ? named : rows.filter((row) => row.references.includes(number));
  if (referenced.length > 1) throw new IndeterminateError(PROVIDER, 'Team Global Express matched several shipments');
  const match = referenced[0];
  if (!match) throw new IndeterminateError(PROVIDER, 'Team Global Express matched a shipment that does not name the number');
  if (!SHIPMENT_ID.test(match.id)) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid shipment id');
  return { id: match.id, shipment: match.shipment };
}

/** A value the shipment page's script assigns, which the server writes as JSON on one line. */
function assigned(html: string, name: string): unknown {
  const line = new RegExp(`^[ \\t]*var ${name}[ \\t]*=[ \\t]*(.+?);[ \\t]*\\r?$`, 'm').exec(html);
  if (!line) unexpected(html, `Team Global Express returned a shipment page without its ${name}`);
  try {
    return JSON.parse(line[1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, `Team Global Express returned an invalid ${name}`, { cause });
  }
}

/** An optional text field; anything but a string or a number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Team Global Express returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** An optional object field. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Team Global Express returned an invalid ${key}`);
  return value;
}

/**
 * A scan's clock, `dd-MM-yyyy hh:mm a`. The page shows it as the local time
 * where the scan happened, or Sydney's when it does not know that zone, and
 * never says which, so it stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const value = text(row, 'dateTimeStamp', 32);
  const parsed = DateTime.fromFormat(value, 'dd-MM-yyyy hh:mm a', { zone: 'UTC', locale: 'en-US' });
  if (!CLOCK.test(value) || !parsed.isValid || parsed.toFormat('dd-MM-yyyy hh:mm a', { locale: 'en-US' }) !== value) {
    throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The suburb a scan names, with its state when the reply gives one. */
function place(row: Record<string, unknown>): string {
  const location = record(row, 'location');
  const suburb = text(location, 'suburb', 80);
  if (!suburb || NO_PLACE.test(suburb)) return '';
  const state = text(location, 'state', 8);
  return state ? `${suburb}, ${state}` : suburb;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = text(row, 'eventCode', 32).toUpperCase();
  const description = text(row, 'eventDesc');
  if (!description) throw new SchemaError(PROVIDER, 'Team Global Express returned a scan without wording');
  const local = scanClock(row);
  const location = place(row);
  const exception = row.isException === true ? text(record(row, 'exception'), 'type', 80) : '';
  const staged = teamGlobalExpressStage(code, text(row, 'status', 16), exception, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The estimate, `dd/MM/yyyy`, as a calendar day. */
function estimate(summary: Record<string, unknown>): string | null {
  const value = text(summary, 'eta', 16);
  const parsed = DateTime.fromFormat(value, 'dd/MM/yyyy', { zone: 'UTC' });
  return ETA.test(value) && parsed.isValid ? parsed.toISODate() : null;
}

/** The shipment's weight in kilograms, as the page shows it; zero is none. */
function weight(summary: Record<string, unknown>): number | null {
  const value = text(summary, 'totalWeights', 16);
  const kilograms = WEIGHT.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/**
 * The shipment page for the shipment a search matched. Its script carries the
 * shipment (`courierStopList`) and its scans (`eventsBeanList`), oldest first;
 * the page draws both from them. A page without the shipment, as for an id it
 * does not know, is not an answer about the number.
 */
export function parseTeamGlobalExpressDetails(html: string, raw: string, match: TeamGlobalExpressMatch): CarrierResult {
  const number = normalizeTeamGlobalExpressNumber(raw);
  const summary = assigned(html, 'courierStopList');
  const rows = assigned(html, 'eventsBeanList');
  if (!isRecord(summary)) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid shipment');
  const shipment = own(text(summary, 'consignmentNumber', 80));
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Team Global Express did not open the shipment its search found');
  const id = text(summary, 'consignmentId', 200);
  if (shipment !== match.shipment || (id && id !== match.id)) throw new IndeterminateError(PROVIDER, 'Team Global Express answered for another shipment');
  // The page writes an empty object for a shipment without scans.
  const list = Array.isArray(rows) ? rows : isRecord(rows) && !Object.keys(rows).length ? [] : null;
  if (!list) throw new SchemaError(PROVIDER, 'Team Global Express returned a shipment with invalid scans');
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Team Global Express returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of list) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the page lists them oldest first.
  const newestFirst = (events[0]!.local_time as string) <= (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const milestone = text(summary, 'status', 16).toUpperCase();
  const filed = teamGlobalExpressMilestoneStage(milestone);
  // The shipment's milestone settles a delivery, a collection or a cancellation;
  // a partial delivery is not a delivery whatever its newest scan says.
  let stage: Stage | undefined = filed === 'delivered' || filed === 'exception' ? filed : scanned?.stage as Stage | undefined;
  if (milestone === 'PRTDEL' && stage === 'delivered') stage = 'in_transit';
  const source = stage && stage !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const service = text(summary, 'serviceType', 80);
  const kilograms = weight(summary);
  const country = text(record(summary, 'receiverLocation'), 'country', 8).toUpperCase();
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(summary);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(service ? { service_name: service } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
