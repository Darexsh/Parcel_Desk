import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { cityExpressStage } from './status.js';

export const PROVIDER = 'City Express';
// The tracking page is about 20 kB and a long history a few kilobytes.
export const CITY_EXPRESS_MAX_BYTES = 512 * 1024;
/** The address of the fragment the tracking form asks for. */
export const CITY_EXPRESS_FRAGMENT = '/htmx-fragment/shipment-trace-by-number-result';

// A centre the tracker offers, the shipment's eight digits and, for one parcel of it, two more.
const NUMBER = /^(68800[125])(\d{8})(\d{2})?$/;
// Spring Security's CSRF token and the header the page's script sends it in.
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const HEADER = /^X-[A-Za-z-]{1,40}$/;
// Firewall and bot-check pages that could stand in for the page or the reply.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;
// The tracker's answer for a number it does not know, in English and in Serbian.
const NOT_FOUND = /^(?:The shipment with this number does not exist or does not have a status yet|Pošiljka sa ovim brojem ne postoji ili još uvek nema status)\.?$/i;
const SHIPMENT_LABEL = /^(?:Shipment Nr|Broj pošiljke)$/i;
// "Parcel nr. 688 005 00000001 16" above a parcel's scans.
const PARCEL = /^(?:Parcel nr\.|Paket br\.)\s*([\d ]{14,24})$/i;
const PRINTED = /^\d{14}(?:\d{2})?$/;
// "04.04.2026 10:21"
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;
// A delivery, a return or a problem, which the status above the scans can decide before they show it.
const ENDED: ReadonlySet<string> = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A City Express number split into the tracker's two fields. */
export interface CityExpressNumber {
  /** The whole number asked: a shipment's fourteen digits or a parcel's sixteen. */
  number: string;
  /** The centre code, the tracker's first field. */
  centre: string;
  /** The eight digits of its second field. */
  serial: string;
  /** The shipment's fourteen digits. */
  shipment: string;
}

/**
 * A shipment number is a centre code the tracker offers and eight digits; a
 * parcel of it adds two. The tracker takes the centre and the eight digits in
 * separate fields, so anything else is not a number it can look up.
 */
export function cityExpressNumber(raw: string): CityExpressNumber {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const match = NUMBER.exec(number);
  if (!match) {
    throw new InvalidInputError(PROVIDER, 'City Express numbers are a centre code 688 001, 688 002 or 688 005 and eight digits, with two more for a parcel');
  }
  return { number, centre: match[1]!, serial: match[2]!, shipment: `${match[1]}${match[2]}` };
}

/** A firewall or bot-check page in place of the site's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

/**
 * The CSRF token of the tracking page and the header its script sends it in.
 * The tracker ignores a centre it does not offer and matches the eight digits
 * alone, so the page's form must still offer the centre asked for.
 */
export function parseCityExpressPage(html: string, centre: string): { header: string; token: string } {
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'City Express answered with a browser check');
  const $ = load(html);
  const tokens = $('meta[name="_csrf"]');
  const headers = $('meta[name="_csrf_header"]');
  const token = tokens.length === 1 ? tokens.attr('content') ?? '' : '';
  const header = headers.length === 1 ? headers.attr('content') ?? '' : '';
  const forms = $('form').filter((_, form) => $(form).attr('hx-get') === CITY_EXPRESS_FRAGMENT);
  if (!TOKEN.test(token) || !HEADER.test(header) || forms.length !== 1
    || forms.find('input[name="track-trace-page-shipment-number"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'City Express tracking page changed');
  }
  const centres = forms.find('select[name="track-trace-page-shipment-center"] option').map((_, option) => $(option).attr('value')).get();
  if (!centres.includes(centre)) throw new SchemaError(PROVIDER, 'City Express tracker no longer offers the centre');
  return { header, token };
}

/** A shipment or parcel number as the reply prints it, in groups: "688 005 00000001 16". */
function printedNumber(text: string): string {
  const digits = /^[\d ]{14,24}$/.test(text) ? text.replace(/ /g, '') : '';
  if (!PRINTED.test(digits)) throw new SchemaError(PROVIDER, 'City Express printed an invalid number');
  return digits;
}

/** A scan's date and minute as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2000 || parsed.toFormat('dd.MM.yyyy HH:mm') !== text) {
    throw new SchemaError(PROVIDER, 'City Express returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

interface Scan { parcel: string | null; local: string; index: number; event: CarrierEvent }

/**
 * The scans under "Tracing details": a clock, then the depot and the wording.
 * A shipment's parcels each come under their number; an older layout lists
 * the shipment's scans without one.
 */
function readScans($: CheerioAPI, lists: Cheerio<Element>): { scans: Scan[]; parcels: string[] } {
  const scans: Scan[] = [];
  const parcels: string[] = [];
  let parcel: string | null = null;
  let clock: string | null = null;
  for (const node of lists.children().toArray()) {
    const child = $(node);
    const tag = node.tagName.toLowerCase();
    if (tag === 'p' && clock === null) {
      const match = PARCEL.exec(clean(child.text(), 80));
      if (!match) throw new SchemaError(PROVIDER, 'City Express history layout changed');
      parcel = printedNumber(match[1]!.trim());
      // A parcel is listed once, and every scan comes under one when any does.
      if (parcels.includes(parcel) || scans.length && !parcels.length) throw new SchemaError(PROVIDER, 'City Express history layout changed');
      parcels.push(parcel);
    } else if (tag === 'dt' && clock === null) {
      clock = wallClock(clean(child.text(), 40));
    } else if (tag === 'dd' && clock !== null) {
      const places = child.children('em');
      const wordings = child.children('span');
      if (places.length > 1 || wordings.length !== 1) throw new SchemaError(PROVIDER, 'City Express scan layout changed');
      const location = clean(places.text(), 120).replace(/\s*:$/, '');
      const description = clean(wordings.text(), 200);
      if (!description) throw new SchemaError(PROVIDER, 'City Express returned a scan without wording');
      if (scans.length >= MAX_ROWS) throw new SchemaError(PROVIDER, 'City Express returned an oversized history');
      const stage = cityExpressStage(description);
      scans.push({ parcel, local: clock, index: scans.length, event: {
        local_time: clock,
        ...(location ? { location } : {}),
        description,
        ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
      } });
      clock = null;
    } else {
      throw new SchemaError(PROVIDER, 'City Express history layout changed');
    }
  }
  if (clock !== null) throw new SchemaError(PROVIDER, 'City Express history layout changed');
  return { scans, parcels };
}

/**
 * The fragment City Express's tracking form shows for a centre and eight
 * digits: the shipment's status, its number and other details, then the scans
 * of each of its parcels, newest first. A number the tracker does not know
 * gets a notice that no shipment has that number or a status yet.
 *
 * The reply must print the shipment asked for. A shipment number covers every
 * parcel and a parcel number only that parcel; a single parcel's shipment
 * prints the parcel's number as its own.
 */
export function parseCityExpress(html: string, raw: string): CarrierResult {
  const asked = cityExpressNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'City Express answered with a browser check');
  const $ = load(html);
  const titles = $('p.tracking-result-title');
  if (!titles.length) {
    const notices = $('div.alert > p');
    if (notices.length === 1 && NOT_FOUND.test(clean(notices.text(), 200))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'City Express returned an unexpected reply');
  }
  const lists = $('dl');
  if (titles.length !== 1 || !lists.length) throw new SchemaError(PROVIDER, 'City Express tracking reply changed');
  const labels = lists.first().children('dt').filter((_, label) => SHIPMENT_LABEL.test(clean($(label).text(), 40)));
  const values = labels.next('dd');
  if (labels.length !== 1 || values.length !== 1) throw new SchemaError(PROVIDER, 'City Express did not name the shipment');
  const printed = printedNumber(clean(values.text(), 40));
  if (printed.slice(0, 14) !== asked.shipment) throw new IndeterminateError(PROVIDER, 'City Express answered for another shipment');

  const { scans, parcels } = readScans($, lists.slice(1));
  if (parcels.some((parcel) => parcel.slice(0, 14) !== asked.shipment)) throw new IndeterminateError(PROVIDER, 'City Express answered for another shipment');
  let chosen = scans;
  // Whether the scans chosen are the whole shipment's, which the status above them describes.
  let whole = true;
  if (asked.number !== asked.shipment) {
    if (parcels.length ? !parcels.includes(asked.number) : printed !== asked.number) {
      throw new IndeterminateError(PROVIDER, 'City Express listed no parcel with that number');
    }
    if (parcels.length) chosen = scans.filter((scan) => scan.parcel === asked.number);
    whole = parcels.length <= 1;
  }

  const seen = new Set<string>();
  const kept = chosen.filter(({ event }) => {
    // Parcels of one shipment can share a scan; it is kept once.
    const identity = JSON.stringify([event.local_time, event.location ?? '', event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // Newest first; equal clocks keep the page's order.
  kept.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = kept.map(({ event }) => event);

  const heading = clean(titles.children('span').first().text(), 120);
  const told = whole && heading ? cityExpressStage(heading) : null;
  if (!events.length) {
    if (!told || !ENDED.has(told.stage)) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(told.stage), current_stage: told.stage, current_stage_source: told.source,
      last_status_text: heading, last_update: null, expected_delivery: null, summary_only: true, events: [] };
  }
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The status decides a delivery, a return or a problem the scans have not
  // shown yet, and whether one parcel's ended journey ends its shipment.
  const several = asked.number === asked.shipment && parcels.length > 1;
  const fromHeading = Boolean(told && told.stage !== scanned?.stage
    && (ENDED.has(told.stage) || several && ENDED.has(scanned?.stage ?? '')));
  const stage = (fromHeading ? told!.stage : scanned?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromHeading ? told!.source : scanned!.stage_source! } : {}),
    last_status_text: fromHeading ? heading : newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
