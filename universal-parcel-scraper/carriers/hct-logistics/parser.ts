import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hctStage } from './status.js';

export const PROVIDER = 'HCT Logistics';
/** The search page HCT's app opens: a WebForms page that posts the number back to itself. */
export const HCT_SEARCH = 'https://www.hct.com.tw/app/searchGoods_index.aspx';
/** The result page the search sends the browser to, with the number the server encrypted. */
export const HCT_RESULT = 'https://www.hct.com.tw/app/searchGoods_Main.aspx';
// A parcel's page is under 15 kB; a number hundreds of scans are filed under came to 250 kB.
export const HCT_MAX_BYTES = 1_000_000;
// The cargo or bill-of-lading number the trackers ask for.
const NUMBER = /^\d{10}$/;
const ZONE = 'Asia/Taipei';
const CLOCK = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}))?$/;
// The page's answer to a number with no scans.
const NO_DATA = '查無此配送資料!!';
// The search's answer: a script that opens the result page for the encrypted number and the key it was encrypted with.
const OPEN_RESULT = /window\.location\.href\s*=\s*'searchGoods_Main\.aspx\?no=([A-Za-z0-9+/]{1,200}={0,2})&v=([0-9A-Fa-f]{32})'/;
// Bot checks and firewall refusals Cloudflare could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
const FIELD = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
const ROW = /^(rtprt_ctl\d{1,4})_L_time$/;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
// HCT issues a number again, and the page keeps listing pickup records of its
// earlier use; HCT's website leaves them out. A scan this much older than the
// next one belongs to that earlier use.
const REUSE_GAP_MS = 90 * 24 * 60 * 60 * 1000;

/** An HCT cargo or bill-of-lading number; anything else is not one it issues. */
export function normalizeHctNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HCT numbers are ten digits');
  return number;
}

/** A page without what HCT's own page has: a browser check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'HCT answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** What the search page posts back to look a number up, as its search button does. */
export function hctSearchFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form#form1');
  if (form.length !== 1 || form.find('input[name="txtpKey2"]').length !== 1 || form.find('#Button1').length !== 1) {
    unexpected(html, 'HCT returned a search page without its form');
  }
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) throw new SchemaError(PROVIDER, 'HCT returned a search page without its state');
  fields.set('__EVENTTARGET', 'Button1');
  fields.set('__EVENTARGUMENT', '');
  fields.set('txtpKey2', number);
  return fields;
}

/**
 * The result page the search's answer opens. The script writes the Base64
 * ciphertext raw; encoding it keeps a `+` from reaching the server as a space.
 */
export function hctResultUrl(html: string): string {
  const match = OPEN_RESULT.exec(html);
  if (!match) unexpected(html, 'HCT answered the search without its result page');
  const url = new URL(HCT_RESULT);
  url.searchParams.set('no', match[1]!);
  url.searchParams.set('v', match[2]!);
  return url.href;
}

interface Row { event: CarrierEvent; at: number; order: number }

/**
 * A scan's clock: the day and minute HCT entered it. HCT delivers only within
 * Taiwan, whose one zone keeps no daylight saving, so the clock is read in
 * Taipei time. A pickup notice can carry only its day, kept as a local date.
 */
function scanClock(text: string): { clock: { time: string } | { local_time: string }; at: number } {
  const parts = CLOCK.exec(text);
  const day = parts ? `${parts[1]}-${parts[2]}-${parts[3]}` : '';
  const wall = parts?.[4] ? `${day}T${parts[4]}:${parts[5]}` : day;
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parts || !zoned.isValid || zoned.toFormat(parts[4] ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd') !== wall) {
    throw new SchemaError(PROVIDER, 'HCT returned an invalid scan time');
  }
  const clock = parts[4] ? { time: zoned.toISO({ suppressMilliseconds: true }) } : { local_time: day };
  return { clock, at: zoned.toMillis() };
}

/**
 * The page's scans: each row's clock and the sentence of what happened, which
 * names the branch or centre in charge as a link to its phone number.
 */
function readRows($: CheerioAPI): Row[] {
  const clocks = $('span[id$="_L_time"]');
  const sentences = $('span[id$="_L_cls"]');
  if (clocks.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'HCT returned an oversized history');
  if (sentences.length !== clocks.length) throw new SchemaError(PROVIDER, 'HCT returned a scan without its clock or sentence');
  return clocks.toArray().map((element, order): Row => {
    const row = ROW.exec($(element).attr('id') ?? '');
    const sentence = row ? $(`span#${row[1]}_L_cls`) : null;
    if (!sentence || sentence.length !== 1) throw new SchemaError(PROVIDER, 'HCT returned a scan without its sentence');
    const description = clean(sentence.text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'HCT returned a scan without its sentence');
    const places = sentence.find('a');
    const location = places.length === 1 ? clean(places.text(), 120) : '';
    const { clock, at } = scanClock(clean($(element).text(), 40));
    const staged = hctStage(description);
    const event: CarrierEvent = {
      ...clock,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { event, at, order };
  });
}

/**
 * The result page for one number. A number with scans is echoed above them;
 * one without gets the page's notice that it has no delivery data, and no
 * number. The scans must sit under the number asked.
 */
export function parseHct(html: string, raw: string): CarrierResult {
  const number = normalizeHctNumber(raw);
  const $ = load(html);
  const echo = $('span#L_invno');
  const notice = $('span#lbl_stats');
  if (echo.length !== 1 || notice.length !== 1) unexpected(html, 'HCT returned a page without its tracking fields');
  const echoed = clean(echo.text(), 64);
  const rows = readRows($);
  if (!echoed) {
    if (rows.length) throw new SchemaError(PROVIDER, 'HCT returned scans without their number');
    if (clean(notice.text(), 200) === NO_DATA) throw new NotFoundError(PROVIDER);
    // The notice that the number could not be decrypted, or another error.
    throw new SchemaError(PROVIDER, 'HCT could not read the number it was sent');
  }
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'HCT answered for another number');
  if (!rows.length) throw new SchemaError(PROVIDER, 'HCT returned a parcel without scans');

  // Newest first, as the page lists them; a pickup notice it appends after them takes its place by its clock.
  const sorted = [...rows].sort((a, b) => b.at - a.at || a.order - b.order);
  const reused = sorted.findIndex((row, index) => index > 0 && sorted[index - 1]!.at - row.at > REUSE_GAP_MS);
  const seen = new Set<string>();
  const events = (reused < 0 ? sorted : sorted.slice(0, reused)).filter(({ event }) => {
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([event.time ?? event.local_time, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && staged!.time ? { delivered_at: staged!.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
