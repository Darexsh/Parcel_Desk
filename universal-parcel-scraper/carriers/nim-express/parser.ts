import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { nimExpressStage } from './status.js';

export const PROVIDER = 'Nim Express';
// A parcel's page is about 50 kilobytes, most of it the site's header, footer and scripts.
export const NIM_EXPRESS_MAX_BYTES = 512 * 1024;
// A bill number: a three-digit branch code, the year and month, and a serial.
const NUMBER = /^\d{12,13}$/;
const ZONE = 'Asia/Bangkok';
// Day, month and Buddhist-era year, then the time to the second.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const BUDDHIST_ERA = 543;
// The card heads each number it was sent with its place in the list and the number.
const TITLE = /^1\. Tracking no\. (\S{1,64})$/;
// The card's answer for a number with no parcel: "Tracking no. is incorrect".
const MISSING = 'Tracking no. ไม่ถูกต้อง';
// The branch or centre's code before its name.
const BRANCH_CODE = /^\d{1,4}\s+(?=\S)/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|requested URL was rejected/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Nim Express bill number: twelve or thirteen digits, as its bills print them. */
export function normalizeNimExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Nim Express bill numbers are twelve or thirteen digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/**
 * A scan's clock. The page writes the Buddhist-era year. Nim Express scans
 * in Thailand, and its few Lao and Cambodian destinations keep the same
 * offset, so the clock is read in Bangkok time, which keeps no daylight saving.
 */
function scanTime(text: string): { time: string; at: number } {
  const parts = CLOCK.exec(text);
  const year = parts ? Number(parts[3]) - BUDDHIST_ERA : 0;
  const wall = parts ? `${String(year).padStart(4, '0')}-${parts[2]}-${parts[1]}T${parts[4]}:${parts[5]}:${parts[6]}` : '';
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  // A Gregorian year, or a clock Luxon would roll over, does not read back unchanged.
  if (!parts || year < 2000 || !zoned.isValid || zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    invalid('Nim Express returned an invalid scan time');
  }
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

interface Row { event: CarrierEvent; at: number; order: number }

/** One timeline entry: its clock, its wording and the branch or centre named under it. */
function readRow(item: Cheerio<Element>, order: number): Row {
  const dates = item.find('.nx-tracking-timeline__date');
  const texts = item.find('.nx-tracking-timeline__desc');
  if (dates.length !== 1 || texts.length !== 1) invalid('Nim Express returned a scan without its clock or wording');
  const refs = texts.find('.nx-tracking-timeline__ref');
  if (refs.length > 1) invalid('Nim Express returned a scan with several places');
  const location = clean(refs.text(), 120).replace(BRANCH_CODE, '');
  const description = clean(texts.clone().find('.nx-tracking-timeline__ref').remove().end().text(), 300);
  if (!description) invalid('Nim Express returned a scan without its wording');
  const { time, at } = scanTime(clean(dates.text(), 40));
  const staged = nimExpressStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at, order };
}

/**
 * The page `www.nimexpress.com/web/p/tracking?h_i={number}` answers. The
 * server renders a card for the number, headed by it, with its timeline newest
 * first; each entry has its clock, its wording and, for scans at a branch or
 * centre, that place. A number without a parcel gets the card's error and an
 * empty timeline. The page's own search field, the client address it echoes,
 * its hidden bill details table and its phone-gated map and document dialogs
 * are not read.
 */
export function parseNimExpress(html: string, raw: string): CarrierResult {
  const number = normalizeNimExpressNumber(raw);
  const $ = load(html);
  const cards = $('.nx-tracking-card');
  if (!cards.length) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nim Express answered with a browser check');
    invalid('Nim Express returned a page without its tracking card');
  }
  if (cards.length !== 1) invalid('Nim Express returned more than one tracking card');
  const titles = cards.find('.nx-tracking-card__title');
  const title = titles.length === 1 ? TITLE.exec(clean(titles.text(), 100)) : null;
  if (!title) invalid('Nim Express returned a card without its number');
  if (title[1] !== number) throw new IndeterminateError(PROVIDER, 'Nim Express answered for another number');

  const timelines = cards.find('ul.nx-tracking-timeline');
  if (timelines.length !== 1) invalid('Nim Express returned a card without its timeline');
  const items = timelines.children('li');
  if (items.length > MAX_ROWS) invalid('Nim Express returned an oversized history');
  if (items.toArray().some((item) => !$(item).hasClass('nx-tracking-timeline__item'))) invalid('Nim Express returned an unexpected timeline');
  const errors = cards.find('.nx-tracking-card__error');
  if (errors.length) {
    if (errors.length > 1 || items.length || clean(errors.text(), 100) !== MISSING) invalid('Nim Express returned an unexpected card error');
    throw new NotFoundError(PROVIDER);
  }
  if (!items.length) throw new NoHistoryError(PROVIDER);

  // Newest first, as the page lists them; the clocks settle an entry out of place.
  const rows = items.toArray().map((item, order) => readRow($(item), order)).sort((a, b) => b.at - a.at || a.order - b.order);
  const seen = new Set<string>();
  const events = rows.filter(({ event }) => {
    // An entry the page lists twice is kept once.
    const identity = JSON.stringify([event.time, event.description, event.location ?? '']);
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
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
