import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, countryTimeZone, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { cyprusPostStage } from './status.js';

export const PROVIDER = 'Cyprus Post';
// The tracking page is about 30 kB, and a results page with a long history under 100 kB.
export const CYPRUS_POST_MAX_BYTES = 1_000_000;
export const CYPRUS_POST_ORIGIN = 'https://www.cypruspost.post';
/** The English results page: the tracking form, and once signed, one lookup's answer. */
export const CYPRUS_POST_RESULTS = `${CYPRUS_POST_ORIGIN}/en/track-n-trace-results`;
/** Where the form posts the number. */
export const CYPRUS_POST_LOOKUP = `${CYPRUS_POST_ORIGIN}/track-and-trace/find`;

const ZONE = 'Asia/Nicosia';
const MAX_FIELDS = 12;
const MAX_ROWS = 500;
const FIELD_NAME = /^[A-Za-z0-9_]{1,64}$/;
// The English history's columns. Only the first four are read: the next office
// is a plan, not a scan, and the extra information can name who signed.
const HEADINGS = ['Time', 'Country', 'Location', 'Event', 'Next Office', 'Extra Information'];
// The notices of the English results page.
const NO_INFORMATION = 'There is no information for this item';
const EXPIRED = 'Token has been expired.';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Web Page Blocked|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|FortiGuard|FortiWeb/i;
const STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/;
// The page cuts country names at 50 characters.
const COUNTRY_LENGTH = 50;
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
// ISO 3166 English short names, as the page prints them, that the shared
// country names lack, without their trailing "(the)".
const ISO_NAMES: ReadonlyMap<string, string> = new Map([
  ['united kingdom of great britain and northern ireland', 'GB'],
  ['korea (the republic of)', 'KR'],
  ["korea (the democratic people's republic of)", 'KP'],
  ['russian federation', 'RU'],
  ['iran (islamic republic of)', 'IR'],
  ['syrian arab republic', 'SY'],
  ['taiwan (province of china)', 'TW'],
  ['moldova (the republic of)', 'MD'],
  ['venezuela (bolivarian republic of)', 'VE'],
  ['bolivia (plurinational state of)', 'BO'],
  ['tanzania, the united republic of', 'TZ'],
  ["lao people's democratic republic", 'LA'],
  ['congo (the democratic republic of the)', 'CD'],
  ['palestine, state of', 'PS'],
]);

/** Cyprus Post's tracker follows S10 item codes: its own, ending CY, and those other posts send to Cyprus. */
export function normalizeCyprusPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Cyprus Post tracks S10 item codes');
}

/** Whether a page is a firewall's or bot check's instead of the site's. */
export function isCyprusPostBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/**
 * The fields the tracking form posts besides the number: the session's form
 * token and the page's hidden honeypot pair, as the page renders them.
 */
export function parseCyprusPostForm(html: string): Record<string, string> {
  const $ = load(html);
  const forms = $('form#track-n-trace-form');
  if (forms.length !== 1) {
    if (isCyprusPostBlockPage(html)) throw new ChallengeError(PROVIDER, 'Cyprus Post answered with a block page');
    throw new SchemaError(PROVIDER, 'Cyprus Post did not return its tracking form');
  }
  const form = forms.first();
  if (form.attr('action') !== CYPRUS_POST_LOOKUP || clean(form.attr('method'), 8).toUpperCase() !== 'POST') {
    throw new SchemaError(PROVIDER, 'Cyprus Post tracking form changed');
  }
  const fields: Record<string, string> = {};
  const inputs = form.find('input[name]');
  if (inputs.length > MAX_FIELDS) throw new SchemaError(PROVIDER, 'Cyprus Post tracking form changed');
  inputs.each((_, node) => {
    const name = $(node).attr('name') ?? '';
    if (name === 'code') return;
    const value = $(node).attr('value') ?? '';
    if (!FIELD_NAME.test(name) || value.length > 2048 || Object.hasOwn(fields, name)) {
      throw new SchemaError(PROVIDER, 'Cyprus Post tracking form changed');
    }
    fields[name] = value;
  });
  if (!/^[A-Za-z0-9]{20,128}$/.test(fields._token ?? '') || form.find('input[name="code"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'Cyprus Post did not return a form token');
  }
  return fields;
}

/**
 * The signed results address the form redirects to: the English results page
 * with the number, an expiry and a signature. A redirect to the home page is
 * the site refusing the session or its token.
 */
export function cyprusPostResultsUrl(location: string, number: string): string {
  let target: URL;
  try { target = new URL(location, CYPRUS_POST_LOOKUP); }
  catch { throw new SchemaError(PROVIDER, 'Cyprus Post tracking redirect is invalid'); }
  const query = target.searchParams;
  if (target.origin === CYPRUS_POST_ORIGIN && target.pathname === '/en/track-n-trace-results' && [...query.keys()].length === 3
    && query.get('code') === number && /^\d{1,12}$/.test(query.get('expires') ?? '') && /^[0-9a-f]{64}$/.test(query.get('signature') ?? '')) {
    return target.href;
  }
  if (target.origin === CYPRUS_POST_ORIGIN && /^\/(?:[a-z]{2}\/?)?$/.test(target.pathname) && !target.search) {
    throw new IndeterminateError(PROVIDER, 'Cyprus Post did not accept the tracking session', { reason: 'session_rejected' });
  }
  throw new IndeterminateError(PROVIDER, 'Cyprus Post sent the lookup to another page');
}

interface Country {
  readonly code: string | null;
  readonly name: string;
}

/** The scan's country, which the page names in English, as ISO 3166 writes it ("Netherlands (the)"). */
function countryOf(text: string): Country {
  const name = text.replace(/\s*\(the\)$/i, '');
  const key = name.toLowerCase();
  let code = countryCode(name) ?? ISO_NAMES.get(key) ?? null;
  if (!code && text.length >= COUNTRY_LENGTH) {
    const cut = [...ISO_NAMES].filter(([full]) => full.startsWith(key));
    if (cut.length === 1) code = cut[0]![1];
  }
  return { code, name: code ? ENGLISH_REGIONS.of(code) ?? name : name };
}

/**
 * The office or facility the scan names, without anything that can locate a
 * person. A Cypriot office comes with its postcode and, after it or a dash, its
 * street or district; only its name is kept. Abroad, a facility can be an
 * office number or a postcode, so a name with a digit is not read.
 */
function facilityOf(place: string, cyprus: boolean): string {
  const name = cyprus ? place.replace(/(?:^|\s+)\d{4}(?:\s.*)?$/, '').replace(/\s+-.*$/, '').trim()
    : /\d/.test(place) ? '' : place;
  return /[A-Za-zͰ-Ͽ]/.test(name) ? name : '';
}

/**
 * When the scan happened: its wall clock ("6/10/2026 13:12"), which carries no
 * offset. Cypriot scans are on Nicosia's clock and a foreign post's on its
 * country's, when that country keeps a single clock; otherwise, or when the
 * clock is ambiguous, it stays local.
 */
function clockOf(stamp: string, zone: string | null): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const match = STAMP.exec(stamp);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) {
    throw new SchemaError(PROVIDER, 'Cyprus Post returned a scan without a valid clock');
  }
  const wall = `${day}T${match[4]!.padStart(2, '0')}:${match[5]}:00`;
  if (zone && DateTime.fromISO(wall, { zone }).getPossibleOffsets().length === 1) {
    const placed = zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", zone);
    if (placed?.iso.startsWith(wall)) return { time: placed.iso };
  }
  return { local_time: wall };
}

interface Scan {
  readonly event: CarrierEvent;
  readonly facility: string;
}

/** One history row's cells, as text: time, country, location, event, next office and extra information. */
function scanOf(cells: readonly string[]): Scan {
  if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'Cyprus Post history columns changed');
  const description = clean(cells[3], 300);
  if (!description) throw new SchemaError(PROVIDER, 'Cyprus Post returned a scan without wording');
  const country = countryOf(clean(cells[1], 80));
  const cyprus = country.code === 'CY';
  const facility = facilityOf(clean(cells[2], 200), cyprus);
  const zone = cyprus ? ZONE : country.code ? countryTimeZone(country.code) : null;
  const location = facility && country.name ? `${facility}, ${country.name}` : facility || country.name;
  return { event: { ...clockOf(clean(cells[0], 40), zone), description, ...(location ? { location } : {}) }, facility };
}

/** The one item the results page answers for, bound to the whole number. */
function itemFor($: CheerioAPI, html: string, number: string) {
  const panels = $('#accordion > .panel');
  if (!panels.length) {
    const notices = $('h3.text-danger').map((_, node) => clean($(node).text(), 120)).get();
    if (notices.includes(EXPIRED)) {
      throw new IndeterminateError(PROVIDER, 'Cyprus Post refused the results link', { reason: 'link_expired' });
    }
    if (isCyprusPostBlockPage(html)) throw new ChallengeError(PROVIDER, 'Cyprus Post answered with a block page');
    throw new SchemaError(PROVIDER, 'Cyprus Post did not return tracking results');
  }
  if (panels.length !== 1) throw new SchemaError(PROVIDER, 'Cyprus Post returned several items for one number');
  const panel = panels.first();
  const titles = panel.find('.panel-heading .panel-title a');
  const bodies = panel.children('.panel-collapse');
  if (titles.length !== 1 || returnedTrackingNumber(titles.text()) !== number
    || bodies.length !== 1 || bodies.attr('id') !== `collapse_${number}`) {
    throw new SchemaError(PROVIDER, 'Cyprus Post answered for a different item');
  }
  return bodies.children('.panel-body');
}

/**
 * The English results page for one number: the item's scans, oldest first,
 * each with its wall clock, country, office or facility and IPS event name. A
 * number without data comes back with a notice instead of a history.
 */
export function parseCyprusPost(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCyprusPostNumber(rawNumber);
  const $ = load(html);
  const body = itemFor($, html, number);
  const tables = body.find('table');
  if (!tables.length) {
    const notices = body.find('h4.text-warning');
    // Only the page's no-information notice is a missing item.
    if (notices.length === 1 && clean(notices.text(), 120) === NO_INFORMATION) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Cyprus Post returned the item without a history');
  }
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Cyprus Post returned several histories for one item');
  const table = tables.first();
  const headings = table.find('thead th').map((_, node) => clean($(node).text(), 40)).get();
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'Cyprus Post did not answer in English');
  const rows = table.find('tbody > tr');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Cyprus Post returned the item without a history', { reason: 'no_history' });
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Cyprus Post returned an invalid item history');

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.each((_, row) => {
    // The extra information is not read: it can name who signed for the item.
    const scan = scanOf($(row).children('td').map((index, cell) => (index < 4 ? $(cell).text() : '')).get());
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  for (const { event } of scans) {
    const classified = cyprusPostStage(event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
  }
  // The page lists the scans oldest first, each on its own country's clock;
  // newest first, scans at the same minute keep the page's order reversed.
  scans.reverse();
  const events = scans.map(scan => scan.event);

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The office an item waits at is its pickup point. A delivered item was
  // collected there when it waited there last before the delivery.
  const earlier = scans.slice(1);
  const waiting = stage === 'ready_for_pickup' ? scans[0]
    : stage === 'delivered' && lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup'
      ? earlier.find(scan => scan.event.stage === 'ready_for_pickup')
      : undefined;
  const point = waiting?.facility ?? '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    events,
  };
}
