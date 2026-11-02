import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { dxStage } from './status.js';

export const PROVIDER = 'DX';
// A page with a long history is under 30 kB.
export const DX_MAX_BYTES = 512 * 1024;

// The patterns DX's tracking page reads from its `/jsoptions/` script to pick
// a tracker: Freight first after Network Services, then the secure tracker for the rest.
const FREIGHT = /^(?:[A-Z]\d{7}|\d{8})$/;
const NETWORK_SERVICES = /^\d{12}$/;
const SECURE = /^.{4,30}$/;
// The page's own check on a freight postcode, after the catalog's.
const MAX_POSTCODE = 8;
// The tracker's one notice, for an unknown number, a wrong postcode and a delivery over 30 days old alike.
const NOTICE = 'DX is unable to find the consignment relating to the details provided.';
// "18/09/26 07:40 AM": the scanning depot's wall clock, two-digit year and a 12-hour clock.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}) (AM|PM)$/;
const DESPATCH = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// The day of the menu's delivery date, "Friday 18th", and its month, "September".
const PLANNED_DAY = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2})(?:st|nd|rd|th)$/;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
  'December'];
// How far after the despatch a delivery date can fall.
const MAX_PLANNED_DAYS = 92;
// A delivery names whoever signed for it: "1 of 1 items delivered. Signed A Name".
const SIGNATORY = /\s*\bSigned\b[\s\S]*$/i;
const WEIGHT = /^(\d{1,5}(?:\.\d{1,3})?) ?kg$/i;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9 /&+().-]{0,59}$/;
const HEADER = ['Date', 'Status', 'Location'];
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A DX Freight consignment number in capitals: a letter and seven digits, or
 * eight digits. DX's page sends twelve digits to its Network Services tracker
 * and anything else of four to thirty characters to its secure delivery
 * tracker, which the adapter does not read.
 */
export function normalizeDxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (FREIGHT.test(number)) return number;
  if (NETWORK_SERVICES.test(number)) {
    throw new IndeterminateError(PROVIDER, 'DX tracks twelve-digit numbers in its Network Services tracker, which the adapter does not read');
  }
  if (SECURE.test(number)) throw new IndeterminateError(PROVIDER, 'DX tracks this number in its secure delivery tracker, which the adapter does not read');
  throw new InvalidInputError(PROVIDER, 'DX tracking numbers are four to thirty characters');
}

/**
 * The delivery postcode the freight tracker asks for with every consignment:
 * trimmed and in capitals, as the page sends it. Without it the tracker shows
 * nothing, so no request is made.
 */
export function normalizeDxPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'the delivery postcode', 'DX Freight shows a consignment only with its delivery postcode');
  if (!DELIVERY_POSTCODE.test(postcode) || postcode.length > MAX_POSTCODE) {
    throw new InvalidInputError(PROVIDER, 'DX Freight requires a valid delivery postcode');
  }
  return postcode;
}

/** A bot check or firewall page in place of the tracker. */
export function isDxChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|Access Denied|Challenge Validation)|_cf_chl_opt|cf-turnstile|captcha|Request Rejected/i
    .test(html.slice(0, 64_000));
}

/** The one element whose server-side id ends with `name`, or none. */
function field($: CheerioAPI, name: string): Cheerio<AnyNode> | null {
  const found = $(`span[id$="_${name}"]`);
  if (found.length > 1) throw new SchemaError(PROVIDER, `DX returned more than one ${name}`);
  return found.length ? found : null;
}

/**
 * Checks that a page of the tracker's session is about the number asked. Its
 * notice is inconclusive: it is the same for an unknown number, a wrong
 * postcode and an old delivery.
 */
function boundPage(html: string, number: string): CheerioAPI {
  const $ = load(html);
  const label = field($, 'ConsNoLabel');
  if (!label) {
    const notice = field($, 'Errorlbl');
    if (notice && clean(notice.text(), 400).startsWith(NOTICE)) {
      throw new IndeterminateError(PROVIDER, 'DX found no consignment for that number and postcode', { reason: 'portal_not_found' });
    }
    if (isDxChallenge(html)) throw new ChallengeError(PROVIDER, 'DX answered with a browser check');
    throw new SchemaError(PROVIDER, 'DX returned a page without its consignment');
  }
  const shown = clean(label.text(), 40).toUpperCase();
  if (!/^[A-Z0-9-]{4,30}$/.test(shown)) throw new SchemaError(PROVIDER, 'DX returned an invalid consignment number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'DX answered for another consignment');
  return $;
}

/** A scan's date and clock as a wall time: the page names no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const hour = match ? Number(match[4]) : 0;
  if (!match || hour < 1 || hour > 12) throw new SchemaError(PROVIDER, 'DX returned an invalid scan time');
  const day = calendarDay(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day || Number(match[5]) > 59) throw new SchemaError(PROVIDER, 'DX returned an invalid scan time');
  const hours = (hour % 12) + (match[6] === 'PM' ? 12 : 0);
  return `${day}T${String(hours).padStart(2, '0')}:${match[5]}:00`;
}

/** A scan's wording without the name of whoever signed for the delivery. */
export function dxWording(text: string): string {
  return clean(text, 300).replace(SIGNATORY, '').replace(/[\s,;:-]+$/, '');
}

/** The day the despatch label gives, as the anchor of the menu's delivery date. */
function despatchDay($: CheerioAPI): string | null {
  const match = DESPATCH.exec(clean(field($, 'lbl_consdate')?.text(), 20));
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/**
 * The menu's delivery date, "will be delivered on Friday 18th of September".
 * It names no year: the one year after the despatch whose calendar gives that
 * weekday is taken, else none.
 */
function plannedDay(menu: CheerioAPI, despatch: string | null): string | null {
  const day = PLANNED_DAY.exec(clean(field(menu, 'DaySpan')?.text(), 40));
  const month = MONTHS.indexOf(clean(field(menu, 'MonthSpan')?.text(), 20)) + 1;
  if (!day || !month || !despatch) return null;
  const from = DateTime.fromISO(despatch, { zone: 'UTC' });
  const fits = [from.year, from.year + 1].flatMap((year) => {
    const iso = calendarDay(year, month, Number(day[2]));
    const date = iso ? DateTime.fromISO(iso, { zone: 'UTC' }) : null;
    const after = date ? date.diff(from, 'days').days : -1;
    return date && WEEKDAYS[date.weekday - 1] === day[1] && after >= 0 && after <= MAX_PLANNED_DAYS ? [iso!] : [];
  });
  return fits.length === 1 ? fits[0]! : null;
}

/** The weight of the whole consignment, in kilograms; none for a missing or zero one. */
function weight($: CheerioAPI): number | null {
  const match = WEIGHT.exec(clean(field($, 'lbl_totalweight')?.text(), 20));
  const kilograms = match ? Number(match[1]) : 0;
  return kilograms > 0 ? kilograms : null;
}

function rows($: CheerioAPI): CarrierEvent[] {
  const table = $('table[id$="_StatusGridView"]');
  if (table.length > 1) throw new SchemaError(PROVIDER, 'DX returned more than one history');
  if (!table.length) {
    // The page prints the newest scan beside the history, so a page that has one and no history changed.
    if (clean(field($, 'lbl_status')?.text())) throw new SchemaError(PROVIDER, 'DX returned a status without its history');
    throw new NoHistoryError(PROVIDER);
  }
  const lines = table.find('tr');
  const header = lines.first().children('th').toArray().map((cell) => clean($(cell).text(), 20));
  if (header.join('|') !== HEADER.join('|')) throw new SchemaError(PROVIDER, 'DX changed its history columns');
  if (lines.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'DX returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const line of lines.slice(1).toArray()) {
    const cells = $(line).children('td');
    if (cells.length !== HEADER.length) throw new SchemaError(PROVIDER, 'DX changed its history layout');
    const local = wallClock(clean(cells.eq(0).text(), 24));
    const description = dxWording(cells.eq(1).text());
    const location = clean(cells.eq(2).text(), 80);
    // A row that only named a signatory says nothing else.
    if (!description) continue;
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = dxStage(description);
    events.push({
      local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/**
 * The two pages the freight tracker shows in the session its lookup opened:
 * the menu with the delivery date, and the tracking history with the service,
 * weight and scans newest first. Both must name the number asked.
 */
export function parseDxFreight(history: string, menu: string, raw: string): CarrierResult {
  const number = normalizeDxNumber(raw);
  const planned = boundPage(menu, number);
  const $ = boundPage(history, number);
  const events = rows($);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // A delivery date already behind the newest scan was missed, and the menu has not moved it.
  const day = stage && SETTLED.has(stage) ? null : plannedDay(planned, despatchDay($));
  const expected = day && day >= (newest.local_time as string).slice(0, 10) ? day : null;
  const service = clean(field($, 'lbl_service')?.text(), 60);
  const kilograms = weight($);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(SERVICE.test(service) ? { service_name: service } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** A page the lookup answered with instead of a redirect: the tracker's notice, a bot check, or a changed reply. */
export function parseDxLookupPage(html: string, raw: string): never {
  boundPage(html, normalizeDxNumber(raw));
  throw new SchemaError(PROVIDER, 'DX answered the lookup without its menu');
}
