import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { packsStage } from './status.js';

export const PROVIDER = 'Packs';
// A lookup's page is about 70 kB, nearly all of it the site's own markup.
export const PACKS_MAX_BYTES = 1024 * 1024;

// Packs works in the Netherlands, Belgium and Luxembourg, which keep one time.
const ZONE = 'Europe/Amsterdam';
// Packs' own shipment numbers.
const SHIPMENT = /^\d{8}$/;
// The tracker also finds a shipment by its barcode or the sender's reference. A
// lookup needs eight characters, so a short fragment never matches.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const DUTCH_POSTCODE = /^[1-9]\d{3}[A-Z]{2}$/;
// Belgium's and Luxembourg's four digits, bare or after their country letters.
const FOUR_DIGIT_POSTCODE = /^(?:BE?|LU?)?([1-9]\d{3})$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;
// The tracker's answer for a number and postcode it holds no shipment under; it writes "bekent".
const NO_RESULT = /^Deze zendingnummer en postcode combinatie is niet beken[dt] in ons systeem!?$/i;
// "29-05-2026 09:49": a status's clock, and the delivery's above the rail.
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
// "dinsdag 23 januari 2024", the day of the expected delivery.
const ETA_DAY = new RegExp(`\\b(\\d{1,2}) (${MONTHS.join('|')}) (\\d{4})\\b`, 'i');
// "08:00 - 18:00" or "tussen 10:00 uur - 15:00 uur", its window.
const ETA_WINDOW = /\b(\d{1,2}):(\d{2})(?: uur)? ?- ?(\d{1,2}):(\d{2})\b/;
const DELIVERED_HEADING = /\bafgeleverd op\b/i;
const MAX_ROWS = 300;

/** A number for Packs' tracker, in capitals; anything else is not one it finds a shipment by. */
export function normalizePacksNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Packs shipment numbers and references are 8 to 30 letters and digits');
  return number;
}

/**
 * The recipient's postcode, which the tracker asks for with every number:
 * a Dutch one without its space, or Belgium's or Luxembourg's four digits.
 */
export function normalizePacksPostcode(raw: string | null | undefined): string {
  const typed = deliveryPostcodeText(raw ?? '');
  if (!typed) throw new InputRequiredError(PROVIDER, 'postcode', 'Packs requires the recipient\'s postcode');
  const compact = typed.replace(/[\s-]/g, '');
  if (DUTCH_POSTCODE.test(compact)) return compact;
  const four = FOUR_DIGIT_POSTCODE.exec(compact);
  if (four) return four[1]!;
  throw new InvalidInputError(PROVIDER, 'Packs requires a Dutch, Belgian or Luxembourg postcode');
}

/** A wall clock in Packs' time, or null when the digits name no time. */
function wallClock(year: string, month: string, day: string, hour: string, minute: string): DateTime | null {
  const local = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00`;
  // Parsing in UTC checks the calendar digits; Luxon would roll 24:00 or 30 February over.
  if (DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) return null;
  return firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
}

/** A "dd-MM-yyyy HH:mm" clock of the page, or null. */
function pageClock(text: string): DateTime | null {
  const match = CLOCK.exec(text);
  return match ? wallClock(match[3]!, match[2]!, match[1]!, match[4]!, match[5]!) : null;
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;

/**
 * The expected delivery above the rail: a day, or a day and a window. Null
 * when the block names none or names it in a way the parser does not read.
 */
function expectedDelivery(text: string): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> | null {
  const day = ETA_DAY.exec(text);
  if (!day) return null;
  const month = String(MONTHS.indexOf(day[2]!.toLowerCase()) + 1);
  const date = wallClock(day[3]!, month, day[1]!, '0', '00');
  if (!date) return null;
  const window = ETA_WINDOW.exec(text.slice(day.index + day[0].length));
  const from = window ? wallClock(day[3]!, month, day[1]!, window[1]!, window[2]!) : null;
  const to = window ? wallClock(day[3]!, month, day[1]!, window[3]!, window[4]!) : null;
  if (from && to && from < to) return { expected_delivery_from: iso(from), expected_delivery: iso(to) };
  return { expected_delivery: date.toISODate()! };
}

/** The text under the shipment-number heading. */
function shipmentNumber($: CheerioAPI, found: Cheerio<AnyNode>): string {
  const heading = found.find('h2').filter((_, element) => clean($(element).text(), 40) === 'Zendingnummer');
  if (heading.length !== 1) throw new SchemaError(PROVIDER, 'Packs returned a shipment without its number');
  const number = normalizeTrackingNumber(clean(heading.next().text(), 64)).toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(number)) throw new SchemaError(PROVIDER, 'Packs returned an invalid shipment number');
  return number;
}

interface Scan { event: CarrierEvent; at: number; order: number }

/** The status details, newest first: each row a clock and the tracker's sentence. */
function statusDetails($: CheerioAPI, found: Cheerio<AnyNode>): CarrierEvent[] {
  const rows = found.find('.status-details-row').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Packs returned an oversized history');
  const scans: Scan[] = rows.map((row, order) => {
    const time = pageClock(clean($(row).children('.status-details-time').text(), 40));
    if (!time) throw new SchemaError(PROVIDER, 'Packs returned an invalid status time');
    const description = clean($(row).children('.status-details-text').text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'Packs returned a status without its wording');
    const staged = packsStage(description);
    return { at: time.toMillis(), order, event: { time: iso(time), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } };
  });
  // The page lists the oldest first; a later row comes first on the same clock.
  return scans.sort((left, right) => right.at - left.at || right.order - left.order).map(({ event }) => event);
}

/**
 * The page `POST https://www.packs.nl/track-trace/` returns for a number and
 * the recipient's postcode, as Packs' tracking form sends them. A shipment's
 * page states its current status above a progress rail, then an expected or
 * actual delivery, the sender and delivery address, the shipment number and
 * the status details. Only the status, the delivery, the shipment number and
 * the details are read. The tracker's notice that it knows no such number and
 * postcode combination is not found; a wrong postcode gets the same notice.
 *
 * Packs' own eight-digit number must come back as the page's shipment number.
 * A barcode or the sender's reference comes back under the shipment number it
 * belongs to, which the result reports as the canonical number.
 */
export function parsePacks(html: string, raw: string): CarrierResult {
  const number = normalizePacksNumber(raw);
  const $ = load(html);
  const found = $('.success-interogation');
  const missing = $('.no-interogation');
  if (!found.length && !missing.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Packs answered with a browser check');
    throw new SchemaError(PROVIDER, 'Packs did not answer the lookup');
  }
  if (found.length + missing.length > 1) throw new SchemaError(PROVIDER, 'Packs returned several answers');
  if (missing.length) {
    if (NO_RESULT.test(clean(missing.find('strong').text(), 200))) {
      throw new NotFoundError(PROVIDER, 'Packs knows no shipment under this number and postcode');
    }
    throw new IndeterminateError(PROVIDER, 'Packs answered with another notice');
  }

  const shipment = shipmentNumber($, found);
  if (shipment !== number && SHIPMENT.test(number)) throw new SchemaError(PROVIDER, 'Packs answered for another shipment');
  const summary = clean(found.find('.status-explication').first().children('span').first().text(), 300);
  if (!summary) throw new SchemaError(PROVIDER, 'Packs returned a shipment without its status');
  const events = statusDetails($, found);

  const extra = found.find('.extra-info-row').first();
  const heading = clean(extra.children('h2').text(), 200);
  const told = clean(extra.find('.eir-ro1-big').toArray().map((span) => $(span).text()).join(' '), 300);
  // "Uw zending is afgeleverd op:" and its clock.
  const deliveredHeading = DELIVERED_HEADING.test(heading);
  const deliveredClock = deliveredHeading ? pageClock(told) : null;

  const scanned = events.find((event) => event.stage);
  const said = packsStage(summary);
  let stage = scanned?.stage as Stage | undefined;
  let source = scanned?.stage_source;
  if (!stage && said) ({ stage, source } = said);
  // The page's own statement of a delivery settles one the details have not reached.
  if (stage !== 'delivered' && deliveredHeading) ({ stage, source } = { stage: 'delivered', source: 'carrier_map' });
  else if (stage !== 'delivered' && said?.stage === 'delivered') ({ stage, source } = said);
  const delivered = stage === 'delivered'
    ? events.find((event) => event.stage === 'delivered')?.time ?? (deliveredClock ? iso(deliveredClock) : undefined) : undefined;
  const eta = stage === 'delivered' || stage === 'returned' ? null : expectedDelivery(told);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: events[0]?.description ?? summary,
    last_update: events[0]?.time ?? delivered ?? null,
    ...(eta ?? { expected_delivery: null }),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
