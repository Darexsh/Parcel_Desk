import { load } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { algeriePosteStage } from './status.js';

export const PROVIDER = 'Algérie Poste';
// The page is about twenty kilobytes, most of it the site's frame.
export const ALGERIE_POSTE_MAX_BYTES = 1024 * 1024;

const MAX_ROWS = 500;
// Algérie Poste's own S10 numbers. Its EY series does not always carry a valid check digit.
const OWN = /^[A-Z]{2}\d{9}DZ$/;
// EMS Champion Post Algérie's domestic express numbers, as its tracking forms' examples give them.
const DOMESTIC = /^E[CDT]\d{11}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|captcha|Attack ID:/i;
// "2026-05-04 09:12" for an EMS event; Algérie Poste's parcel network gives the day only.
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * The tracker looks up S10 item codes with a valid check digit, Algérie
 * Poste's own ending DZ and those of the posts that send items to Algeria,
 * Algérie Poste's own codes even without one, and EMS Champion Post
 * Algérie's domestic express numbers.
 */
export function normalizeAlgeriePosteNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || OWN.test(number) || DOMESTIC.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Algérie Poste tracks S10 item codes and EMS domestic numbers of EC, ED or ET and eleven digits');
}

/** A firewall's page in place of the tracker's, which is no answer about the item. */
export function assertNotChallenged(body: string): void {
  if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Algérie Poste answered with a firewall page');
}

/**
 * A scan's date as the page prints it: the scanning office's wall clock to
 * the minute for an EMS event, whose zone the page does not give, else the
 * day alone. Neither gets an offset.
 */
function localTime(text: string): string {
  const match = DATE.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Algérie Poste returned an invalid scan date');
  const [hours, minutes, seconds = '00'] = match.slice(4) as [string | undefined, string | undefined, string | undefined];
  if (hours === undefined || minutes === undefined) return day;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    throw new SchemaError(PROVIDER, 'Algérie Poste returned an invalid scan time');
  }
  return `${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * The tracker's page for one number, `track/index.php?icd=`, which the site
 * renders on its server: a heading naming the number, a notice when an EMS
 * item was delivered, then a timeline of its scans, newest first, each with a
 * wording, an office and a date. Only the heading and the timeline are read.
 * The page
 * shows the same heading over an empty timeline for a number it holds nothing
 * for, without a notice, so an empty history is inconclusive.
 */
export function parseAlgeriePoste(html: string, rawNumber: string): CarrierResult {
  const number = normalizeAlgeriePosteNumber(rawNumber);
  assertNotChallenged(html);
  const $ = load(html);
  const section = $('section.cd-timeline');
  // The heading's own line; a delivered EMS item adds a notice below it with its own heading.
  const heading = section.find('.main-heading').children('h2').children('font');
  const timeline = section.find('.cd-timeline__container');
  if (section.length !== 1 || heading.length !== 1 || timeline.length !== 1) {
    throw new SchemaError(PROVIDER, 'Algérie Poste returned a page without the tracker');
  }
  if (normalizeTrackingNumber(clean(heading.text(), 64)) !== number) {
    throw new SchemaError(PROVIDER, 'Algérie Poste answered for a different item');
  }
  const blocks = timeline.find('.cd-timeline__block').toArray();
  if (blocks.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Algérie Poste returned an oversized history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const content = $(block).children('.cd-timeline__content');
    const wording = content.children('h2');
    const office = content.children('p');
    const date = content.children('.cd-timeline__date');
    if (content.length !== 1 || wording.length !== 1 || office.length !== 1 || date.length !== 1) {
      throw new SchemaError(PROVIDER, 'Algérie Poste returned an invalid history row');
    }
    const local = localTime(clean(date.text(), 32));
    const description = clean(wording.text(), 200);
    const location = clean(office.text(), 120);
    // A row without a wording still dates the item at an office; one without either says nothing.
    if (!description && !location) continue;
    const key = [local, location, description].join('\n');
    // The tracker can list one scan twice.
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = algeriePosteStage(description);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description ?? null,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
