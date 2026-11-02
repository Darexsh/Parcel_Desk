import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { blueexStage } from './status.js';

export const PROVIDER = 'BlueEX';
// A reply is a few kilobytes of HTML for one number.
export const BLUEEX_MAX_BYTES = 256 * 1024;

// The tracking box's own check: ten digits from 4000000000 to 6999999999, or
// CP and twelve digits.
const NUMBER = /^(?:[4-6]\d{9}|CP\d{12})$/;
const ZONE = 'Asia/Karachi';
// A scan, as "Aug 4th, 2026(03:04 PM) - Out For Delivery".
const SCAN = /^([A-Z][a-z]{2}) (\d{1,2})(st|nd|rd|th), (\d{4})\((\d{2}:\d{2} [AP]M)\) - (.+)$/;
const CLOCK_FORMAT = 'MMM d yyyy hh:mm a';
const LABEL = /^BlueEX Shipping Label : (\S{1,40})/;
// A station scan ends with its city after a comma or a dash, as
// "Shipment reached blueEX Lahore Operations, Lahore".
const STATION = /^Shipment (?:has )?reached\b.*(?:,|\s-)\s+([A-Za-z][A-Za-z .'()-]*?)\.?$/i;
// A delivery names who took the parcel after "to".
const DELIVERED_TO = /^((?:Shipment has been )?Delivered)\s+to\b.*$/i;
// Pakistani phone numbers, as 0300-1234567, +92 300 1234567 or 021-111-000-000.
const PHONE = /(?<![\dA-Z])(?:\+|00)?(?:92|0)(?:[\s-]?\d){9,11}(?!\d)/gi;
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;
const MAX_EVENTS = 300;

/** A BlueEX consignment number as its tracking box takes it; anything else is not one it issues. */
export function normalizeBlueexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'BlueEX numbers are ten digits from 4000000000 to 6999999999, or CP and twelve digits');
  }
  return number;
}

/** A scan's wording without who took the parcel or a phone number. */
export function blueexWording(text: string): string {
  return clean(text.replace(PHONE, ''), 300).replace(DELIVERED_TO, '$1').replace(/[\s,;:-]+$/, '');
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/** A wall clock to the minute, read in Karachi time: BlueEX scans in Pakistan, which keeps one offset. */
function clock(month: string, day: string, suffix: string, year: string, minute: string): { time: string; at: number } {
  const written = `${month} ${Number(day)} ${year} ${minute}`;
  // UTC only checks the calendar fields.
  const checked = DateTime.fromFormat(written, CLOCK_FORMAT, { zone: 'UTC', locale: 'en-US' });
  if (!checked.isValid || checked.toFormat(CLOCK_FORMAT, { locale: 'en-US' }) !== written || ordinal(Number(day)) !== suffix) {
    throw new SchemaError(PROVIDER, 'BlueEX returned an invalid time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(checked.toFormat("yyyy-MM-dd'T'HH:mm"), { zone: ZONE }));
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

interface Scan { event: CarrierEvent; at: number; order: number }

/**
 * The tracker's reply for one number: a block naming the number, a progress
 * rail and the scans oldest first, each a date, a minute and BlueEX's
 * wording. An empty reply is what the page reports as no tracking
 * information; the progress rail is not read.
 */
export function parseBlueex(html: string, raw: string): CarrierResult {
  const number = normalizeBlueexNumber(raw);
  if (!html.trim()) throw new IndeterminateError(PROVIDER, 'BlueEX gave no answer for the number');
  const $ = load(html);
  const blocks = $('.trackingInformation');
  if (!blocks.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BlueEX answered with a block page');
    throw new SchemaError(PROVIDER, 'BlueEX did not return a tracking result');
  }
  if (blocks.length !== 1) throw new SchemaError(PROVIDER, 'BlueEX returned several tracking results');
  const shown = clean(blocks.find('.sngltrackno').text(), 80);
  const inner = blocks.find('.trackinfoInner');
  const label = LABEL.exec(clean(inner.children('p.blue').first().text(), 200))?.[1];
  if (!shown || inner.length !== 1 || !label) throw new SchemaError(PROVIDER, 'BlueEX returned a result without its number');
  if (shown !== number || label !== number) throw new IndeterminateError(PROVIDER, 'BlueEX answered for another number');

  const lines = inner.children('p').not('.blue').toArray();
  if (lines.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'BlueEX returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  lines.forEach((line, order) => {
    const match = SCAN.exec(clean($(line).text(), 400));
    if (!match) throw new SchemaError(PROVIDER, 'BlueEX returned a scan without its date or wording');
    const when = clock(match[1]!, match[2]!, match[3]!, match[4]!, match[5]!);
    const description = blueexWording(match[6]!);
    if (!description) throw new SchemaError(PROVIDER, 'BlueEX returned a scan without wording');
    const location = STATION.exec(description)?.[1]?.trim();
    const staged = blueexStage(description);
    const event: CarrierEvent = {
      time: when.time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const identity = JSON.stringify([event.time, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, at: when.at, order });
  });
  // A number the tracker holds no scans for gets the same block without a notice.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans at the same minute keep the page's order, which is oldest first, turned round.
  const events = scans.sort((a, b) => b.at - a.at || b.order - a.order).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    events,
  };
}
