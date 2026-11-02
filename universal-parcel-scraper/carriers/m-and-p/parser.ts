import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { mAndPStage } from './status.js';

export const PROVIDER = 'M&P';
// A page is about 250 kB, most of it menus, script and a chat widget.
export const M_AND_P_MAX_BYTES = 1_000_000;

// Consignment numbers seen are twelve or fifteen digits.
const NUMBER = /^\d{12,15}$/;
const ZONE = 'Asia/Karachi';
// The day, the month's short name, the year and a twelve-hour clock, as "04 Jun 2026 05:14 pm".
const CLOCK = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2}) ([AaPp][Mm])$/;
const NOT_FOUND = /^No tracking record found with the provided consignment number\.?$/i;
// A firewall's or bot check's page, read only on a page without the tracker's
// result area. The site's quote form draws its own captcha, so the word alone
// is no block.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com/i;
// Who took a delivered parcel, from where the sentence names them to its end.
const RECEIVER = /[\s,]*(?:\band\s+)?(?:has been\s+)?\b(?:rec(?:ie|ei)ved|signed|collected)\s+by\b.*$/i;
// A run of ten or more digits with spaces or hyphens, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s-]?\d){9,}(?![A-Z\d])/gi;
// An amount to collect in rupees.
const AMOUNT = /\b(?:Rs\.?|PKR)\s*\d[\d,]*(?:\.\d+)?/gi;
// Stands for a line break while a sentence's text is read.
const BREAK = '\u2029';
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** An M&P consignment number: twelve to fifteen digits. */
export function normalizeMAndPNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'M&P consignment numbers are twelve to fifteen digits');
  return number;
}

/** A scan's sentence without who took the parcel, phone numbers or an amount to collect. */
export function mAndPSentence(text: string): string {
  return clean(text.replace(RECEIVER, '').replace(PHONE, '').replace(AMOUNT, ''), 300)
    .replace(/\s+([,.;:])/g, '$1').replace(/[\s,;:]+$/, '');
}

/**
 * The text of a node, a line break read as the end of a sentence: a failed
 * attempt's reason is followed by a line on the next try.
 */
function sentences(node: Cheerio<AnyNode>): string {
  const copy = node.clone();
  copy.find('br').replaceWith(BREAK);
  return copy.text().split(BREAK).map((line) => clean(line, 300)).filter(Boolean)
    .map((line, index, lines) => (index < lines.length - 1 && !/[.!?:]$/.test(line) ? `${line}.` : line)).join(' ');
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'M&P answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/**
 * A wall clock to the minute without an offset, read in Karachi time: M&P's
 * network is in Pakistan, which keeps one offset without daylight saving.
 */
function clock(text: string): { time: string; at: number } {
  const match = CLOCK.exec(text);
  const written = match ? `${match[1]!.padStart(2, '0')} ${match[2]} ${match[3]} ${match[4]!.padStart(2, '0')}:${match[5]} ${match[6]!.toUpperCase()}` : '';
  // UTC only checks the calendar fields.
  const checked = DateTime.fromFormat(written, 'dd LLL yyyy hh:mm a', { zone: 'UTC', locale: 'en-US' });
  if (!checked.isValid || checked.toFormat('dd LLL yyyy hh:mm a', { locale: 'en-US' }) !== written) {
    throw new SchemaError(PROVIDER, 'M&P returned an invalid scan time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(checked.toFormat("yyyy-MM-dd'T'HH:mm"), { zone: ZONE }));
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

interface Scan { event: CarrierEvent; at: number }

/**
 * The tracker's page for one consignment, which the server renders: a form
 * with the number as asked, the booking date, the shipper and consignee with
 * their cities, then the scans newest first, each with a date, a clock, a
 * status label, the city and a sentence. A consignment the tracker has no
 * record of gets its notice instead of scans. The booking details, names,
 * cities and the order reference are not read, nor who took the parcel.
 */
export function parseMAndP(html: string, rawNumber: string): CarrierResult {
  const number = normalizeMAndPNumber(rawNumber);
  const $ = load(html);
  const section = $('#orderTrackSection .order-track');
  const asked = $('form#trackingForm input#consignmentInput');
  if (section.length !== 1 || asked.length !== 1) unexpected(html, 'M&P returned a page without its tracking result');
  // The form shows the number the page was opened for.
  const shown = clean(asked.attr('value'), 64);
  if (!shown) throw new SchemaError(PROVIDER, 'M&P returned a result without its number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'M&P answered for another consignment');

  const steps = section.children('.order-track-step');
  if (!steps.length) {
    if (section.find('p').toArray().some((node) => NOT_FOUND.test(clean($(node).text(), 200)))) throw new NotFoundError(PROVIDER);
    if (clean(section.text(), 200)) throw new SchemaError(PROVIDER, 'M&P returned a result it did not explain');
    throw new NoHistoryError(PROVIDER);
  }
  if (steps.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'M&P returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  steps.each((_, node) => {
    const step = $(node);
    const date = step.find('.order-track-text-sub');
    const label = step.find('.order-track-text-stat.status');
    const place = step.find('.order-track-text-stat.location');
    const message = step.find('.order-track-text-stat.status-message');
    if (date.length !== 1 || label.length !== 1 || place.length > 1 || message.length > 1) {
      throw new SchemaError(PROVIDER, 'M&P returned an invalid scan');
    }
    const when = clock(clean(date.text(), 40));
    const status = clean(label.text(), 80);
    const sentence = message.length ? mAndPSentence(sentences(message)) : '';
    const description = sentence || status;
    if (!description) throw new SchemaError(PROVIDER, 'M&P returned a scan without wording');
    const location = clean(place.text(), 120);
    const staged = mAndPStage(status, sentence);
    const event: CarrierEvent = {
      time: when.time, description, ...(location ? { location } : {}),
      ...(status ? { provider_code: status } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const identity = JSON.stringify([event.time, status, description, location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, at: when.at });
  });
  // Newest first; scans at the same minute keep the page's order, which is newest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.at - a.at).map(({ event }) => event);

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
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
