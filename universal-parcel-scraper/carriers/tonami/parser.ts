import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tonamiMappedStage, tonamiStage } from './status.js';

export const PROVIDER = 'Tonami Transportation';
export const CARRIER = 'tonami';
// A page is about 35 kB.
export const TONAMI_MAX_BYTES = 512 * 1024;
/** Every branch is in Japan, and the tracker prints its wall clock without a zone. */
export const TONAMI_ZONE = 'Asia/Tokyo';
// Ten digits, the last a check digit: the rest divided by seven.
const NUMBER = /^\d{10}$/;
// "08月26日", with the minute on the delivery row: "08月26日 11:01". No year.
const CLOCK = /^(\d{2})月(\d{2})日(?: (\d{2}):(\d{2}))?$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const NOT_FOUND = '該当伝票番号なし';
const HISTORY_HEADINGS = ['状況', '日時', '店所名', '電話番号', '住所', '備考'];
const WEIGHT = /^(\d{1,3}(?:,\d{3})*|\d{1,7})(?:\.\d{1,3})?$/;
const MAX_ROWS = 20;
// A leap day needs up to four years back.
const YEARS_BACK = 4;

/** A number for Tonami's tracker: ten digits with their check digit, printed hyphens removed. */
export function normalizeTonamiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw.normalize('NFKC')) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Tonami inquiry numbers have ten digits');
  if (!hasMod7CheckDigit(number)) throw new InvalidInputError(PROVIDER, 'The Tonami inquiry number check digit does not match');
  return number;
}

type Selection = ReturnType<CheerioAPI>;

/**
 * A row's day, with its minute when it has one. The tracker prints a month and
 * a day without a year: the year is the latest that puts the day no later than
 * the day after the lookup in Japan. A day alone stays a day; a minute is read
 * in Japan's zone.
 */
function rowClock(text: string, now: number): { time: string } | { local_time: string } {
  const match = CLOCK.exec(text);
  if (match) {
    const [month, day] = [Number(match[1]), Number(match[2])];
    const latest = DateTime.fromMillis(now, { zone: TONAMI_ZONE }).plus({ days: 1 });
    const limit = latest.toISODate()!;
    for (let year = latest.year; year >= latest.year - YEARS_BACK; year -= 1) {
      const date = calendarDay(year, month, day);
      if (!date || date > limit) continue;
      if (match[3] === undefined) return { local_time: date };
      const wall = `${date}T${match[3]}:${match[4]}`;
      const parsed = zonedTime(`${date} ${match[3]}:${match[4]}`, 'yyyy-MM-dd HH:mm', TONAMI_ZONE);
      // Only a clock that reads back unchanged is kept: Luxon would roll 24:00 over to the next day.
      if (parsed?.iso.slice(0, 16) === wall) return { time: parsed.iso };
      break;
    }
  }
  throw new SchemaError(PROVIDER, 'Tonami returned an invalid scan time');
}

/** The detail block's fields by their label. */
function detailFields($: CheerioAPI, detail: Selection): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of detail.children('tbody').children('tr').toArray()) {
    const cells = $(row).children('th, td').toArray();
    for (const [index, cell] of cells.entries()) {
      if (cell.tagName !== 'th') continue;
      const name = clean($(cell).text(), 40);
      const value = cells[index + 1];
      if (name && value?.tagName === 'td' && !fields.has(name)) fields.set(name, $(value).text().normalize('NFKC').replace(/\s+/g, ' ').trim());
    }
  }
  return fields;
}

/**
 * The history table, one fixed row per milestone in the order a parcel reaches
 * them: its name, the day, with the minute on the delivery row, the branch,
 * its phone number, its town and a remark. A milestone not reached has no day
 * and is left out; the phone number, the town and the remark, which can give a
 * partner's number, are not kept. Newest first: a later day goes first, and
 * rows of one day keep the reverse of the tracker's order.
 */
function eventsOf($: CheerioAPI, table: Selection, now: number): CarrierEvent[] {
  const headings = table.find('thead th').toArray().map((heading) => clean($(heading).text(), 40));
  if (headings.join('|') !== HISTORY_HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Tonami changed its history table');
  const rows = table.find('tbody > tr').toArray();
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Tonami returned an invalid history');
  const events: { day: string; event: CarrierEvent }[] = [];
  for (const row of rows) {
    const name = $(row).children('th');
    const cells = $(row).children('td');
    const description = clean(name.text(), 40);
    if (name.length !== 1 || cells.length !== HISTORY_HEADINGS.length - 1 || !description) {
      throw new SchemaError(PROVIDER, 'Tonami returned an invalid history row');
    }
    const text = clean(cells.eq(0).text(), 40);
    if (!text) continue;
    const clock = rowClock(text, now);
    const location = clean(cells.eq(1).text(), 120);
    const staged = tonamiStage(description);
    events.push({
      day: 'time' in clock ? clock.time.slice(0, 10) : clock.local_time,
      event: { ...clock, ...(location ? { location } : {}), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
    });
  }
  return events.reverse().sort((left, right) => right.day.localeCompare(left.day)).map(({ event }) => event);
}

/** The weight the detail shows, in kilograms; none when it shows none. */
function weightOf(text: string | undefined): number | null {
  const value = (text ?? '').trim();
  const kilograms = WEIGHT.test(value) ? Number(value.replace(/,/g, '')) : Number.NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/**
 * The tracker's page for the numbers asked, `/trc/search3/excSearch3?id[0]=`,
 * which it renders on its server: a list with a row per number, and for each
 * number it holds a detail block with the number, the current state, the
 * acceptance day and branch, the delivering or partner branch, the parcel
 * count, the weight and the history. The block's number must be the one asked;
 * a parcel handed to a partner adds the partner's number after it. A number it
 * does not hold, or no longer holds after about three months, gets
 * "該当伝票番号なし" in its list row and no block. The parcel count, the
 * branches' phone numbers and towns, the volume and the partner's number are not
 * kept.
 */
export function parseTonami(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeTonamiNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Tonami answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const asked = $('input[name="id[0]"]');
  if (asked.length !== 1) throw new SchemaError(PROVIDER, 'Tonami returned an unexpected page');
  if (normalizeTrackingNumber(clean(asked.attr('value'), 40)) !== number) throw new IndeterminateError(PROVIDER, 'Tonami answered for another number');
  const details = $('#detail0');
  if (!details.length) {
    const listed = clean(asked.closest('tr').children('td').eq(2).text(), 80);
    if (listed === NOT_FOUND && !$('table.statusTable').length) throw new NotFoundError(PROVIDER, 'Tonami has no shipment for this number');
    throw new SchemaError(PROVIDER, 'Tonami returned a page without a shipment');
  }
  const detail = details.closest('table');
  if (details.length !== 1 || detail.length !== 1) throw new SchemaError(PROVIDER, 'Tonami returned an invalid shipment detail');
  const fields = detailFields($, detail);
  const shown = /^(\d{10})(?:\s|\[|$)/.exec(fields.get('お問い合わせ番号') ?? '')?.[1];
  if (!shown) throw new SchemaError(PROVIDER, 'Tonami returned a shipment without its number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'Tonami answered for another shipment');
  const summary = clean(fields.get('最新状況'), 80);
  const histories = detail.find('table.statusTable');
  if (!summary || histories.length !== 1) throw new SchemaError(PROVIDER, 'Tonami returned a shipment without its state');

  const events = eventsOf($, histories, now);
  const newest = events[0];
  // The summary is the carrier's current state; the newest staged row decides only a state the map does not know.
  const listed = tonamiMappedStage(summary);
  const scanned = events.find((event) => event.stage);
  const stage = (listed ?? scanned?.stage) as Stage | undefined;
  const source = listed ? 'carrier_map' : scanned?.stage_source;
  if (!newest && !listed) throw new NoHistoryError(PROVIDER);
  const weight = weightOf(fields.get('重量(kg)'));
  const delivered = stage === 'delivered' && newest?.stage === 'delivered' && typeof newest.time === 'string' ? newest.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: summary,
    last_update: typeof newest?.time === 'string' ? newest.time : null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    timezone: TONAMI_ZONE,
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
