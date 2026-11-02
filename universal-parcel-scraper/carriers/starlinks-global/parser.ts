import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { starlinksGlobalPlace, starlinksGlobalStage } from './status.js';

export const PROVIDER = 'Starlinks Global';
export const CARRIER = 'starlinks-global';
// A tracking page with a long history is under a hundred kilobytes.
export const STARLINKS_GLOBAL_MAX_BYTES = 1024 * 1024;

// Three letters naming the shipper, four digits, the country it sends from and eleven digits.
const NUMBER = /^[A-Z]{3}\d{4}[A-Z]{2}\d{11}$/;
// The last-mile courier's number, as the page gives it.
const PARTNER_NUMBER = /^[A-Z0-9]{8,40}$/;
const UNKNOWN = 'Parcel not found';
// "2026-10-26 09:01:57": the event's clock, to the second.
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CLOCK_FORMAT = 'yyyy-MM-dd HH:mm:ss';
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 500;

/** A Starlinks Global tracking number. The tracker also finds a parcel by its courier's number, which is the courier's to track. */
export function normalizeStarlinksGlobalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Starlinks Global numbers are three letters, four digits, a country code and eleven digits');
  }
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** An event's date and second as one wall time. The page gives no zone. */
function wallClock(text: unknown): string {
  const parsed = typeof text === 'string' && CLOCK.test(text) ? DateTime.fromFormat(text, CLOCK_FORMAT, { zone: 'UTC' }) : null;
  // UTC only checks the calendar fields; no offset is assigned.
  if (!parsed?.isValid || parsed.year < 2000 || parsed.toFormat(CLOCK_FORMAT) !== text) {
    throw new SchemaError(PROVIDER, 'Starlinks Global returned an invalid event time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Starlinks Global returned an invalid ${field}`);
  return value.replace(/\s+/g, ' ').trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The last-mile courier from its tracking link, with its number when that differs. */
function lastMile(parcel: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = typeof parcel.track_number === 'string' ? normalizeTrackingNumber(parcel.track_number).toUpperCase() : '';
  let url: URL;
  try {
    url = new URL(typeof parcel.carrier_tracking_url === 'string' ? parcel.carrier_tracking_url : '');
  } catch {
    return {};
  }
  // Only a courier the link's address names, for the number in the link, is a
  // hand-off: the courier's name is the page's own label for its service.
  const partner = ['https:', 'http:'].includes(url.protocol) && PARTNER_NUMBER.test(reference) && url.href.toUpperCase().includes(reference)
    ? carrierIdFromPartner('', url.href) : undefined;
  if (!partner || partner === CARRIER || partner === 'unknown') return {};
  return { delivery_carrier: partner, ...(reference !== number ? { delivery_tracking_number: reference } : {}) };
}

/**
 * The tracking page Starlinks Global serves for a number. Its tracking
 * component carries the parcel as JSON in its `:parcel` attribute, and the
 * number searched in `:search`; a number the tracker does not know leaves the
 * parcel null with the error "Parcel not found".
 *
 * The parcel must be the whole number asked. Its events come newest first,
 * each with a wall clock, a title from a short list and a text that can end
 * with the place and its country. The recipient's town is not read.
 */
export function parseStarlinksGlobal(html: string, raw: string): CarrierResult {
  const number = normalizeStarlinksGlobalNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Starlinks Global answered with a browser check');
  const $ = load(html);
  const pages = $('public-tracking-page');
  if (pages.length !== 1) throw new SchemaError(PROVIDER, 'Starlinks Global returned an unexpected page');
  const json = (name: string): unknown => {
    const value = pages.attr(name);
    if (value === undefined) throw new SchemaError(PROVIDER, 'Starlinks Global returned an unexpected page');
    try {
      return JSON.parse(value);
    } catch {
      throw new SchemaError(PROVIDER, 'Starlinks Global returned an unexpected page');
    }
  };
  const searched = json(':search');
  if (typeof searched !== 'string') throw new SchemaError(PROVIDER, 'Starlinks Global returned an unexpected page');
  if (normalizeTrackingNumber(searched).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Starlinks Global answered for another shipment');

  const payload = json(':parcel');
  if (payload === null) {
    if (pages.attr('error') === UNKNOWN) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Starlinks Global refused the lookup');
  }
  const parcel = record(payload);
  if (!parcel || typeof parcel.system_track_number !== 'string' || !Array.isArray(parcel.events) || typeof parcel.isCancelled !== 'boolean') {
    throw new SchemaError(PROVIDER, 'Starlinks Global returned an unexpected parcel');
  }
  // The tracker finds a parcel by its courier's number too: only the parcel under the number asked is this one.
  if (normalizeTrackingNumber(parcel.system_track_number).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Starlinks Global answered for another shipment');
  }
  // The page hides a cancelled parcel's history and says nothing of what became of it.
  if (parcel.isCancelled) throw new IndeterminateError(PROVIDER, 'Starlinks Global shows the shipment as cancelled');
  if (!parcel.events.length) throw new NoHistoryError(PROVIDER);
  if (parcel.events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Starlinks Global returned an oversized history');

  const statuses = parcel.events.map((item, index) => {
    const entry = record(item);
    if (!entry) throw new SchemaError(PROVIDER, 'Starlinks Global returned an invalid event');
    const local = wallClock(entry.date);
    const title = text(entry.title, 'event title');
    const details = entry.description === null || entry.description === undefined ? '' : text(entry.description, 'event text');
    if (!title) throw new SchemaError(PROVIDER, 'Starlinks Global returned an event without a title');
    const description = details || title;
    // A country alone names no place.
    const { place, country } = starlinksGlobalPlace(description);
    const location = place ? `${place}, ${country}` : '';
    const staged = starlinksGlobalStage(title, description);
    const event: CarrierEvent = {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { local, index, event };
  });
  // Newest first; of equal clocks, the event higher on the page is the newer.
  statuses.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = statuses.map(({ event }) => event);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  const destination = typeof parcel.consignee_country === 'string' && /^[A-Z]{2}$/.test(parcel.consignee_country) ? parcel.consignee_country : undefined;
  const weight = typeof parcel.weight === 'number' && Number.isFinite(parcel.weight) && parcel.weight > 0 && parcel.weight_unit === 'kg' ? parcel.weight : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...lastMile(parcel, number),
    events,
  };
}
