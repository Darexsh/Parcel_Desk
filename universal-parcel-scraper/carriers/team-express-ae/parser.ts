import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import type { CarrierId } from '../../generated/catalog.js';
import { teamExpressCodeStage, teamExpressStage } from './status.js';

export const PROVIDER = 'Team Express';
export const CARRIER = 'team-express-ae';
// The page is about 40 kB, most of it the site's menus and footer.
export const TEAM_EXPRESS_MAX_BYTES = 512 * 1024;
// SMART and seven digits on archived exports, RAKPOS and eight digits on a bank's domestic deliveries.
const NUMBER = /^(?:SMART\d{7}|RAKPOS\d{8})$/;
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2}) ?([AP]M)$/i;
// A firewall or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;
// The despatch center's scans name the company, not a place.
const NO_PLACE = /^(?:team express)?$/i;
const HISTORY = ['date', 'time', 'location', 'status', 'status details'];
const MAX_ROWS = 300;

/** A Team Express airwaybill in capitals, as the tracker shows it; anything else is not one it issues. */
export function normalizeTeamExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Team Express airwaybills are SMART and seven digits, or RAKPOS and eight');
  return number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** A scan's wall clock, to the minute: the page names no zone, and an export ends abroad. */
function wallClock(day: string, time: string): string {
  const date = DATE.exec(day);
  const clock = TIME.exec(time);
  const hour = clock ? Number(clock[1]) : 0;
  const minute = clock ? Number(clock[2]) : 0;
  const calendar = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!calendar || !clock || hour < 1 || hour > 12 || minute > 59) throw new SchemaError(PROVIDER, 'Team Express returned an invalid scan time');
  return `${calendar}T${pad((hour % 12) + (/^p/i.test(clock[3]!) ? 12 : 0))}:${pad(minute)}:00`;
}

/** The summary table's values by their label: Airwaybill No, Origin, Destination, Current Status and so on. */
function summaryOf($: CheerioAPI, block: Cheerio<AnyNode>): Map<string, Cheerio<AnyNode>> {
  const rows = new Map<string, Cheerio<AnyNode>>();
  block.find('table').first().find('tr').each((_, row) => {
    const label = $(row).children('th');
    const value = $(row).children('td');
    if (label.length === 1 && value.length === 1) rows.set(clean(label.text(), 40).toLowerCase(), value);
  });
  return rows;
}

const textOf = (rows: Map<string, Cheerio<AnyNode>>, label: string, maxLength = 120) => clean(rows.get(label)?.text(), maxLength);

/** A scan from one row of the history: date, time, location, status and status details. */
function scan(cells: Cheerio<AnyNode>): CarrierEvent {
  const cell = (index: number, maxLength: number) => clean(cells.eq(index).text(), maxLength);
  const code = cell(3, 60);
  const details = cell(4, 200);
  const description = details || code;
  if (!description) throw new SchemaError(PROVIDER, 'Team Express returned a scan without wording');
  const place = cell(2, 80);
  const staged = teamExpressStage(code, details);
  return {
    local_time: wallClock(cell(0, 20), cell(1, 20)),
    ...(NO_PLACE.test(place) ? {} : { location: place }),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The history table's scans, newest first and each once. */
function history($: CheerioAPI, block: Cheerio<AnyNode>): CarrierEvent[] {
  const table = block.find('table').filter((_, node) => {
    const headings = $(node).find('tr').first().children('th').map((__, cell) => clean($(cell).text(), 40).toLowerCase()).get();
    return headings.join('|') === HISTORY.join('|');
  });
  if (table.length > 1) throw new SchemaError(PROVIDER, 'Team Express tracking page changed');
  const rows = table.find('tr').slice(1);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Team Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length !== HISTORY.length) throw new SchemaError(PROVIDER, 'Team Express scan layout changed');
    const event = scan(cells);
    const identity = JSON.stringify([event.local_time, event.provider_code, event.description, event.location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  // Newest first, as the page lists them; an oldest-first history is turned round.
  return events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
}

/**
 * Whether the number has the partner's shape: one of the partner's detection
 * rules offers it or, for a partner whose rules claim no shape, its own
 * tracking link in the reply opens that number.
 */
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as string[]).includes(partner)) return true;
  if (CARRIER_DEFINITIONS[partner as CarrierId]?.detectionRules.length !== 0) return false;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * The partner abroad that an export was handed to, and its forwarding number.
 * The page names the partner only through its "View Details" link, so both
 * stand when that link is one catalog carrier's and the number has that
 * carrier's shape. The link is never followed.
 */
function partner(value: Cheerio<AnyNode> | undefined, own: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (!value) return {};
  const link = clean(value.find('a').attr('href'), 500);
  const reference = normalizeTrackingNumber(clean(value.clone().find('a').remove().end().text(), 80)).toUpperCase();
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === own) return {};
  const carrier = carrierIdFromPartner('', link);
  if (!carrier || carrier === CARRIER || !partnerShape(carrier, reference, link)) return {};
  return { delivery_carrier: carrier, delivery_tracking_number: reference };
}

/** The destination's country, after the last dash: "CHINA - CHINA", "RAS AL KHAIMAH, NA - UNITED ARAB EMIRATES". */
function destination(rows: Map<string, Cheerio<AnyNode>>): Pick<CarrierResult, 'destination_country'> {
  const country = countryCode(textOf(rows, 'destination').split(/\s+-\s+/).at(-1));
  return country ? { destination_country: country } : {};
}

/**
 * The page `teamexpressme.com/tracking?trackno={number}` renders: the
 * tracking form, then for a shipment it holds a block headed with its
 * airwaybill, with the summary (service, origin, destination, current status
 * and, once delivered, who signed and when) and the scans newest first. A
 * number it does not hold, unknown or expired, gets the form alone, which says
 * nothing about the number.
 */
export function parseTeamExpress(html: string, raw: string): CarrierResult {
  const number = normalizeTeamExpressNumber(raw);
  const $ = load(html);
  if (!$('form[action^="/tracking"] input[name="trackno"]').length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Team Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'Team Express did not return its tracking page');
  }
  const blocks = $('.track_details');
  if (!blocks.length) throw new IndeterminateError(PROVIDER, 'Team Express showed nothing for the number');
  const own = blocks.filter((_, node) => {
    const shown = textOf(summaryOf($, $(node)), 'airwaybill no', 64);
    if (!shown) throw new SchemaError(PROVIDER, 'Team Express returned a shipment without its airwaybill');
    return normalizeTrackingNumber(shown).toUpperCase() === number;
  });
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Team Express answered for another shipment');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Team Express showed several shipments for the number');

  const rows = summaryOf($, own);
  const events = history($, own);
  const current = textOf(rows, 'current status', 60);
  const summarized = current ? teamExpressCodeStage(current) : undefined;
  const service = textOf(rows, 'service type', 80);
  const facts = {
    ...(service ? { service_name: service } : {}),
    ...destination(rows),
    ...partner(rows.get('forwarding number'), number),
  };
  const summary = (stage: Stage) => ({
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: current,
    provider_code: current,
  });
  if (!events.length) {
    // A shipment without scans can still have the tracker's current status.
    if (!summarized) throw new NoHistoryError(PROVIDER);
    return { ...summary(summarized), last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [] };
  }

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // A delivery abroad shows only in the summary: an export's scans stop when it leaves Dubai.
  const settled = summarized === 'delivered' && scanned?.stage !== 'delivered';
  const stage = (scanned?.stage ?? summarized) as Stage | undefined;
  return {
    ...(settled ? summary('delivered') : {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
      last_status_text: newest.description!,
    }),
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...facts,
    events,
  };
}
