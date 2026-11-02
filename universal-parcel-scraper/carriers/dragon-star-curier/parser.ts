import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { dragonStarCurierMappedStage, dragonStarCurierStage } from './status.js';

export const PROVIDER = 'Dragon Star Curier';
// A parcel's page is about 70 kB, most of it the site's own markup.
export const DRAGON_STAR_CURIER_MAX_BYTES = 1024 * 1024;
const PAGE = 'https://dragonstarcurier.ro/tracking-awb';
// AWB numbers are bare digits: seven and eight are seen, and nine lets the next length through.
const NUMBER = /^\d{7,9}$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
// The page's notice for a number it holds nothing for: "The AWB code entered is invalid."
const NOT_FOUND = /codul awb introdus este invalid/;
// Its notice when the lookup behind it fails: "An error occurred. Please try again later."
const FAILED = /a aparut o eroare/;
// A scan's clock as the page prints it, "15.02.2026, 11:27".
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2})$/;
// A scan's wording can start with DSC's code for it, as "PRL - Preluata".
const CODED = /^([A-Z]{2,4}) - (.+)$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between
// them, as phone numbers are written; a scan's clock has fewer.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A clause naming who signed for or took the parcel, as Romanian couriers write it.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:semnat[aă]?\s*(?:de\b|:)|semn[aă]tur[aă]|(?:primit|ridicat|confirmat)[aă]?\s+de\b(?!\s+la\b)|predat[aă]?\s+(?:lui|c[aă]tre)\b)[\s\S]*$/i;
const MAX_ROWS = 300;

/** A DSC AWB number; anything else is not one it issues. */
export function normalizeDragonStarCurierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dragon Star Curier AWB numbers are seven to nine digits');
  return number;
}

/** The tracker's page for one AWB number. */
export function dragonStarCurierTrackingUrl(raw: string): string {
  return `${PAGE}?${new URLSearchParams({ awb: normalizeDragonStarCurierNumber(raw) })}`;
}

/** Lower case, single spaces and no diacritics, for the page's own labels. */
function fold(text: string): string {
  return clean(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Text without phone numbers or a clause naming who took the parcel. */
export function dragonStarCurierText(text: string, maxLength = 300): string {
  return clean(clean(text, 500).replace(RECEIVER, '').replace(PHONE, ''), maxLength).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The section heading the page gives a part of the parcel's page. */
function heading(main: Cheerio<Element>, $: CheerioAPI, text: string): Cheerio<Element> {
  return main.find('h3').filter((_index, element) => fold($(element).text()) === text);
}

/** The value of one box of the page's Delivery details, under its small label. */
function detail(main: Cheerio<Element>, $: CheerioAPI, label: string): string | undefined {
  const labels = main.find('div.text-uppercase').filter((_index, element) => fold($(element).text()) === label);
  if (labels.length > 1) throw new SchemaError(PROVIDER, `Dragon Star Curier returned several ${label} boxes`);
  return labels.length ? clean(labels.next().text(), 300) : undefined;
}

/** A scan's wall clock to the minute. The page names no zone, so it stays local. */
function wallClock(text: string): string {
  const clock = CLOCK.exec(clean(text, 32));
  const local = clock ? `${clock[3]}-${clock[2]}-${clock[1]}T${clock[4]}:${clock[5]}:00` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Dragon Star Curier returned an invalid scan time');
  }
  return local;
}

/** The scans of the Delivery history, newest first as the page lists them. */
function scans(main: Cheerio<Element>, $: CheerioAPI): CarrierEvent[] {
  const history = heading(main, $, 'istoric livrare');
  if (history.length > 1) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned several histories');
  // A parcel without scans has no history section.
  if (!history.length) return [];
  const rows = history.next('div.row').find('h5').toArray();
  if (!rows.length) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a history without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    // The wording and the place share a block; the clock is the block after it.
    const title = $(row);
    const text = clean(title.text(), 300);
    const coded = CODED.exec(text);
    const code = coded?.[1] ?? '';
    const description = dragonStarCurierText(coded?.[2] ?? text);
    if (!description) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a scan without wording');
    const local = wallClock(title.parent().next().text());
    const location = dragonStarCurierText(title.nextAll('span').first().text(), 80);
    const key = JSON.stringify([local, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = dragonStarCurierStage(code, description);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/** The page without a parcel: the tracker's notice says why. */
function noParcel(main: Cheerio<Element>): never {
  const notice = fold(main.find('label.text-danger').text());
  if (NOT_FOUND.test(notice)) throw new NotFoundError(PROVIDER);
  if (FAILED.test(notice)) throw new IndeterminateError(PROVIDER, 'Dragon Star Curier could not complete the lookup');
  if (notice) throw new IndeterminateError(PROVIDER, 'Dragon Star Curier answered with another notice');
  throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a page without a parcel');
}

/**
 * DSC's tracker, `tracking-awb?awb={number}`, for one AWB number. A parcel's
 * page repeats the number in its heading and its Delivery details, whose
 * Status box reads "{phase} - {newest scan}", and lists its scans under
 * Delivery history, newest first. An unknown number gets the page's notice
 * instead, which does not repeat it.
 */
export function parseDragonStarCurier(html: string, raw: string): CarrierResult {
  const number = normalizeDragonStarCurierNumber(raw);
  const $ = load(html);
  const main = $('main#main');
  if (main.length !== 1 || !$('input#awb').length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Dragon Star Curier answered with a browser check');
    throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a page without its tracker');
  }
  const progress = heading(main, $, 'progres livrare');
  if (!progress.length) return noParcel(main);

  const titles = main.find('h2').filter((_index, element) => /^nr\. awb\b/.test(fold($(element).text())));
  const echoed = detail(main, $, 'numar awb');
  if (titles.length !== 1 || echoed === undefined) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a parcel without its number');
  if (clean(titles.text(), 64).replace(/^Nr\. AWB\s*/i, '') !== number || echoed !== number) {
    throw new IndeterminateError(PROVIDER, 'Dragon Star Curier answered for another number');
  }
  const status = dragonStarCurierText(detail(main, $, 'status') ?? '');
  if (!status) throw new SchemaError(PROVIDER, 'Dragon Star Curier returned a parcel without its status');

  const events = scans(main, $);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The Status box starts with the step of the progress bar the parcel is at.
  const phase = dragonStarCurierMappedStage(null, status.split(' - ')[0]!);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = (phase ?? scanned?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: phase ? 'carrier_map' : scanned!.stage_source! } : {}),
    last_status_text: status,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
