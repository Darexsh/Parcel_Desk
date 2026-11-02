import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeExpressOneNumber } from '../express-one/parser.js';
import { eurodisQuiet, eurodisStage } from './status.js';

export const PROVIDER = 'EURODIS';
// A page is about 30 kB; each collo of a large shipment adds its own history.
export const EURODIS_MAX_BYTES = 1024 * 1024;

// A collo barcode: 24 characters, digits for most members and letters in
// front for some, as on Slovak parcels.
const BARCODE = /^(?=[A-Z]*\d)[A-Z0-9]{24}$/;
const SHIPMENT = /^\d{13}$/;
// The page's notice for a search that found nothing, the same for every search form.
const ABSENT = 'No shipment matching with the entered tracking criteria!';
// What the shipment's history lists while it has none.
const NO_HISTORY = 'No history information available';
// A scan's date and minute, then its place and country after slashes.
const STAMP = /^(\d{4})-(\d{2})-(\d{2}),\s*(\d{2}):(\d{2})(?:\s*\/\s*(.*))?$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|g-recaptcha|hcaptcha\.com|captcha-delivery\.com|_Incapsula_Resource/i;
const MAX_SCANS = 1000;
const MAX_EVENTS = 200;

export type EurodisLookupKind = 'collo' | 'shipment';
export interface EurodisLookup { number: string; kind: EurodisLookupKind }

/** A number EURODIS's tracker takes: a collo barcode or a thirteen-digit shipment number. */
export function eurodisLookup(raw: string): EurodisLookup {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (SHIPMENT.test(number)) return { number, kind: 'shipment' };
  if (BARCODE.test(number)) return { number, kind: 'collo' };
  throw new InvalidInputError(PROVIDER, 'EURODIS tracks 24-character collo barcodes and thirteen-digit shipment numbers');
}

type Selection = ReturnType<CheerioAPI>;
interface Scan { wall: string; country: string | null; event: CarrierEvent }
interface Collo { number: string; partner: string; status: string; scans: Scan[] }

/**
 * The visible label rows of an overview table, by their label in lower case.
 * Rows the page hides until the recipient's ZIP code is entered (the sender,
 * the receiver and who took the parcel) are never read.
 */
function labelled($: CheerioAPI, table: Selection): Map<string, string> {
  const rows = new Map<string, string>();
  table.find('tr').each((_, tr) => {
    const row = $(tr);
    if (/display\s*:\s*none/i.test(row.attr('style') ?? '')) return;
    const cells = row.children('td');
    if (cells.length !== 2 || !cells.first().hasClass('ref-tit')) return;
    const label = clean(cells.first().text(), 80).replace(/:$/, '').toLowerCase();
    if (rows.has(label)) throw new SchemaError(PROVIDER, 'EURODIS repeated an overview field');
    rows.set(label, clean(cells.last().text(), 120));
  });
  return rows;
}

/**
 * A whole reference from an overview field. The shipment's and colli's own
 * numbers must read as one; a partner's number in another form is left out.
 */
function reference(rows: Map<string, string>, label: string, required: boolean): string {
  const value = normalizeTrackingNumber(rows.get(label) ?? '');
  if (/^[A-Z0-9]{4,40}$/.test(value)) return value;
  if (required) throw new SchemaError(PROVIDER, `EURODIS returned no valid ${label}`);
  return '';
}

/**
 * A scan's clock. The page gives a wall clock to the minute and no offset; it
 * is the clock of the country the scan names, so it is read in that country's
 * zone. A scan without a country, or in a country with several zones, keeps
 * its wall clock.
 */
function clockOf(stamp: RegExpExecArray, country: string | null): { at: { time: string } | { local_time: string }; wall: string } {
  const [, year, month, day, hour, minute] = stamp;
  const fields = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
  // UTC only checks the calendar fields; no offset is assigned.
  const calendar = DateTime.fromObject(fields, { zone: 'UTC' });
  if (!calendar.isValid || calendar.hour !== fields.hour || calendar.day !== fields.day) throw new SchemaError(PROVIDER, 'EURODIS returned an invalid scan time');
  const wall = calendar.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const time = inCountry(wall, country);
  return { at: time ? { time } : { local_time: wall }, wall };
}

/** A wall clock's instant in a single-zone country, or null; a clock the spring change skips has none. */
function inCountry(wall: string, country: string | null): string | null {
  const zone = country ? countryTimeZone(country) : null;
  const zoned = zone ? firstOccurrence(DateTime.fromISO(wall, { zone })) : null;
  return zoned?.isValid && zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall ? zoned.toISO({ suppressMilliseconds: true }) : null;
}

/** One entry of a timeline: its wording, then its date, minute, place and country. */
function scanOf(item: Selection): Scan | null {
  const heading = item.find('h6');
  if (!heading.length) {
    if (clean(item.text(), 120) === NO_HISTORY) return null;
    throw new SchemaError(PROVIDER, 'EURODIS returned a scan without wording');
  }
  const description = clean(heading.text(), 200);
  const body = item.children('div').clone();
  body.find('h6, span').remove();
  const stamp = STAMP.exec(clean(body.text(), 300));
  if (heading.length !== 1 || !description || !stamp) throw new SchemaError(PROVIDER, 'EURODIS returned a malformed scan');
  const parts = (stamp[6] ?? '').split('/').map((part) => clean(part, 120)).filter(Boolean);
  const last = parts.at(-1) ?? '';
  const country = /^[A-Z]{2}$/.test(last) ? countryCode(last) : null;
  const place = (country ? parts.slice(0, -1) : parts).join(' / ');
  const location = place && country ? `${place}, ${country}` : place || country || '';
  const { at, wall } = clockOf(stamp, country);
  const staged = eurodisStage(description);
  return { wall, country, event: {
    ...at,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

function scansOf($: CheerioAPI, items: Selection): Scan[] {
  return items.toArray().map((item) => scanOf($(item))).filter((scan): scan is Scan => scan !== null);
}

/** Each collo of the shipment with its own references, status and timeline. */
function colliOf($: CheerioAPI): Collo[] {
  return $('.coli-wrapper .ship-reference > div').toArray().map((node) => {
    const block = $(node);
    const table = block.children('table.ship-info-content');
    if (table.length !== 1) throw new SchemaError(PROVIDER, 'EURODIS returned a collo without its overview');
    const rows = labelled($, table);
    return { number: reference(rows, 'colli number', true), partner: reference(rows, 'colli number delivery partner', false),
      status: rows.get('status') ?? '', scans: scansOf($, block.find('ul.delivery-status-list > li')) };
  });
}

// The members a hand-off can name, as the page writes them, with the rule
// their own trackers apply to a number.
const MEMBERS: ReadonlyMap<string, { carrier: string; accepts: (number: string) => boolean }> = new Map([
  ['express one', { carrier: 'express-one', accepts: (number: string) => {
    try {
      return normalizeExpressOneNumber(number) === number;
    } catch {
      return false;
    }
  } }],
  ['österreichische post', { carrier: 'austrian-post', accepts: (number: string) => {
    const match = detectCarrierMatch(number);
    return match.carrier === 'austrian-post' || (match.candidates as readonly string[]).includes('austrian-post');
  } }],
]);

/**
 * The member the page sends the recipient to once the shipment reached the
 * destination country: the first line under "You are the receiver? Please
 * contact". Before then the block names nobody.
 */
function deliveringMember($: CheerioAPI): string {
  const blocks = $('.link_element .receiver-results').filter((_, node) =>
    clean($(node).children('span').first().text(), 80) === 'You are the receiver? Please contact');
  if (blocks.length !== 1) return '';
  const lines = (blocks.children('div').first().html() ?? '').split(/<br\s*\/?>/i)
    .map((line) => clean(load(`<p>${line}</p>`)('p').text(), 120)).filter(Boolean);
  return lines[0] ?? '';
}

function handoff(member: string, partner: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const known = MEMBERS.get(member.toLowerCase());
  if (!known || !partner || !known.accepts(partner)) return {};
  return { delivery_carrier: known.carrier, delivery_tracking_number: partner };
}

function stageOf(text: string): { stage?: Stage; source?: string } {
  const staged = eurodisStage(text);
  return staged ? { stage: staged.stage, source: staged.source } : {};
}

/**
 * EURODIS's tracking page for one collo barcode or shipment number. A found
 * shipment has its overview and history, then each collo with its own
 * overview and timeline, newest first. A barcode must be one of the colli and
 * a shipment number the shipment's own; a page for another shipment, or for
 * several, is inconclusive. The recipient's ZIP code unlocks the sender's and
 * receiver's details, which are never asked for.
 */
export function parseEurodis(html: string, raw: string): CarrierResult {
  const { number, kind } = eurodisLookup(raw);
  const $ = load(html);
  if (!$('#main.tracking-page').length) {
    if (CHALLENGE.test(html.slice(0, 200_000))) throw new ChallengeError(PROVIDER, 'EURODIS answered with a bot check');
    throw new IndeterminateError(PROVIDER, 'EURODIS did not return its tracking page');
  }
  const notices = $('.errorMsg').toArray().map((node) => clean($(node).text(), 200)).filter(Boolean);
  const shipments = $('.shipm-wrapper');
  if (!shipments.length) {
    if (notices.length === 1 && notices[0] === ABSENT) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, notices.length ? 'EURODIS refused the search' : 'EURODIS returned no shipment');
  }
  if (notices.length) throw new SchemaError(PROVIDER, 'EURODIS returned a shipment under a notice');
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'EURODIS answered with several shipments');
  if ($('.ship-history li, ul.delivery-status-list > li').length > MAX_SCANS) throw new SchemaError(PROVIDER, 'EURODIS returned an oversized history');

  const overview = labelled($, shipments.find('.ship-info table.ship-info-content').first());
  const shipment = reference(overview, 'shipment number eurodis', true);
  if (!SHIPMENT.test(shipment)) throw new SchemaError(PROVIDER, 'EURODIS returned an invalid shipment number');
  const colli = colliOf($);
  if (!colli.length) throw new SchemaError(PROVIDER, 'EURODIS returned a shipment without colli');
  const own = kind === 'collo' ? colli.filter((collo) => collo.number === number || collo.partner === number) : colli;
  if (kind === 'shipment' ? shipment !== number : own.length !== 1) throw new IndeterminateError(PROVIDER, 'EURODIS answered for another shipment');

  // The shipment's history belongs to every collo; it joins a barcode's own
  // timeline only when the shipment has that one collo. A shipment scan a
  // collo also lists at the same minute and place, as "delivered completely"
  // beside the collo's "delivered", is the collo's.
  const colloScans = own.flatMap((collo) => collo.scans);
  const shipmentScans = kind === 'shipment' || colli.length === 1 ? scansOf($, shipments.find('.ship-history li')) : [];
  const listed = new Set(colloScans.map((scan) => JSON.stringify([scan.wall, scan.event.location ?? null])));
  const seen = new Set<string>();
  const scans = [...colloScans, ...shipmentScans.filter((scan) => !listed.has(JSON.stringify([scan.wall, scan.event.location ?? null])))]
    .filter((scan) => {
      const key = JSON.stringify([scan.wall, scan.event.description, scan.event.location ?? null]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Newest first by the scans' wall clocks, as the page orders them; one
  // minute keeps the page's order.
  const ordered = scans.map((scan, index) => ({ scan, index }))
    .sort((left, right) => (left.scan.wall < right.scan.wall ? 1 : left.scan.wall > right.scan.wall ? -1 : left.index - right.index))
    .map(({ scan }) => scan);
  const destination = overview.get('destination country') ?? '';
  const country = countryCode(destination);
  // Once the newest scan that names a country is in the destination country,
  // the later scans without a place, the delivery depot and the round, are there too.
  const arrived = ordered.findIndex((scan) => scan.country);
  const events = ordered.map((scan, index) => {
    const { local_time: wall, ...event } = scan.event;
    const time = index < arrived && !scan.country && typeof wall === 'string' && ordered[arrived]!.country === country
      ? inCountry(wall, country) : null;
    return time ? { time, ...event } : scan.event;
  });

  const single = colli.length === 1 ? colli[0]! : null;
  const partner = kind === 'collo' ? own[0]!.partner || (single ? reference(overview, 'shipment number delivery partner', false) : '')
    : reference(overview, 'shipment number delivery partner', false) || single?.partner || '';
  const common = {
    expected_delivery: null,
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...handoff(deliveringMember($), partner),
  };

  if (!events.length) {
    const text = kind === 'collo' ? own[0]!.status || (single ? overview.get('status') ?? '' : '') : overview.get('status') ?? '';
    if (!text) throw new NoHistoryError(PROVIDER);
    const { stage, source } = eurodisQuiet(text) ? {} : stageOf(text);
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
      last_status_text: text,
      last_update: null,
      ...common,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  // An arrangement for the delivery keeps the stage of the scan before it.
  const current = events.find((event) => !eurodisQuiet(event.description ?? ''));
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    ...(stage === 'delivered' && current?.time ? { delivered_at: current.time } : {}),
    ...common,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
