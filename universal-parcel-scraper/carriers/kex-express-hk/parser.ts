import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { kexHkStage } from './status.js';

export const PROVIDER = 'KEX Express Hong Kong';
// A page is about eighteen kilobytes, most of it menus and script.
export const KEX_HK_MAX_BYTES = 512 * 1024;

// Eight to twenty letters and digits with a digit: a letter and nine digits
// today, KEHK and ten characters under the former name, and the app's own
// example of a letter and seven digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,20}$/;
// The tracker's answer to a number it has no record of, in English and Chinese.
const NOT_FOUND = /have not yet received information of this tracking no|尚未收到運單資訊/i;
// Its answer to an input it does not read as a number, which it does not echo.
const INVALID = /Invalid input the tracking no/i;
// A firewall or bot check's page, read only on a page without the tracker's
// result area. Every tracker page loads Imperva's `SWJIYLWA` script; its
// refusal frames another `_Incapsula_Resource`.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|Pardon Our Interruption)|_cf_chl_opt|cf-turnstile|Incapsula incident|_Incapsula_Resource\?(?!SWJIYLWA)|captcha/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HALF = /^(?:AM|PM)$/;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;
// A run of eight or more digits with spaces, dots or hyphens, as Hong Kong
// phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;
// A locker's or pickup point's collection code after its label; the label stays.
const PICKUP_CODE = /((?:pick-?up|collection|locker)\s*(?:code|pin|password)|取件碼|取件码|提件碼|密碼|密码)(?:\s*(?:is|:|：))?\s*(?:\d(?:[\s-]?\d){3,}|(?=[A-Z]*\d)[A-Z\d]{4,})/gi;

/** A number for KEX Express Hong Kong's tracker, in upper case; anything else is not one it issues. */
export function normalizeKexHkNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'KEX Express Hong Kong numbers are eight to twenty letters and digits');
  return number;
}

/** A scan's wording without phone numbers or a collection code. */
export function kexHkWording(text: string): string {
  return clean(text.replace(PICKUP_CODE, '$1').replace(PHONE, ''), 300)
    .replace(/\s+([,.;:，。])/g, '$1').replace(/[\s,;:，：]+$/, '');
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'KEX Express Hong Kong answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** A calendar day checked digit for digit. */
function calendarDay(text: string): string {
  const parsed = DateTime.fromISO(text, { zone: 'UTC' });
  if (!DAY.test(text) || !parsed.isValid || parsed.toISODate() !== text) {
    throw new SchemaError(PROVIDER, 'KEX Express Hong Kong returned an invalid scan date');
  }
  return text;
}

interface Scan {
  /** The day and half-day, which order the scans. */
  order: string;
  event: CarrierEvent;
}

/**
 * The tracker's page for the numbers in its `track` parameter. The server
 * renders a block per number under `#trackArea`: the number as it was typed,
 * then a timeline whose rows hold a day, `AM` or `PM` and the scan's wording.
 * The current page lists them newest first; an older one listed them oldest
 * first. A number the tracker has no record of gets one row with its notice
 * and no day.
 */
export function parseKexHk(html: string, rawNumber: string): CarrierResult {
  const number = normalizeKexHkNumber(rawNumber);
  const $ = load(html);
  const area = $('#trackArea');
  if (area.length !== 1) unexpected(html, 'KEX Express Hong Kong returned a page without its results');
  const blocks = area.find('div.main');
  if (blocks.length !== 1) throw new SchemaError(PROVIDER, 'KEX Express Hong Kong did not answer for one number');
  const rows = blocks.find('ul.cbp_tmtimeline > li').not('.clearfix').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'KEX Express Hong Kong returned an oversized history');
  const lines = rows.map((row) => clean($(row).find('.cbp_tmlabel h4').text(), 400));
  const undated = rows.length === 1 && $(rows[0]).find('time span').length === 0;
  if (undated && INVALID.test(lines[0]!)) throw new InvalidInputError(PROVIDER, 'KEX Express Hong Kong did not take the number', { reason: 'wrong_number' });

  // The block shows the number as typed; the tracker matches whole numbers in any case.
  const shown = clean(blocks.children('p').first().text(), 80);
  if (!shown) throw new SchemaError(PROVIDER, 'KEX Express Hong Kong returned a result without its number');
  if (shown.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'KEX Express Hong Kong answered for another number');
  if (undated && NOT_FOUND.test(lines[0]!)) throw new NotFoundError(PROVIDER);
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  const scans: Scan[] = rows.map((row, index) => {
    const spans = $(row).find('time.cbp_tmtime > span').toArray().map((span) => clean($(span).text(), 20));
    const description = kexHkWording(lines[index]!);
    if (spans.length !== 2 || !HALF.test(spans[1]!) || !description) {
      throw new SchemaError(PROVIDER, 'KEX Express Hong Kong returned a scan without its day, half-day or wording');
    }
    const day = calendarDay(spans[0]!);
    const staged = kexHkStage(description);
    // The page gives a day and whether it was morning or afternoon, not a clock.
    return { order: `${day} ${spans[1]}`, event: {
      local_time: day, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } };
  });
  // Newest first; an oldest-first page is turned round, and scans in the same half-day keep the page's order.
  if (scans[0]!.order < scans.at(-1)!.order) scans.reverse();
  scans.sort((a, b) => b.order.localeCompare(a.order));
  const seen = new Set<string>();
  const events = scans.filter(({ order, event }) => {
    const identity = JSON.stringify([order, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
