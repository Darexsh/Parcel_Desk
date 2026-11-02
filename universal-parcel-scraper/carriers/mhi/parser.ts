import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { MHI_LAYOUT } from './number.js';
import { mhiStage } from './status.js';

export const PROVIDER = 'MHI';
export const CARRIER = 'mhi';
// A tracking page with a long history is under fifty kilobytes.
export const MHI_MAX_BYTES = 1024 * 1024;

// The courier's number beside the link to its tracker.
const PARTNER_NUMBER = /^[A-Z0-9]{6,40}$/;
const UNKNOWN = /^No details found for Tracking Code, or Tracking Code not recognised\b/;
// "24 Oct 2026" and "08:36": the event's day and minute.
const DAY_FORMAT = 'd MMM yyyy';
const MINUTE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 500;

/** An MHI tracking number, as stored: without the dashes its older labels print. */
export function normalizeMhiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!MHI_LAYOUT.test(number)) {
    throw new InvalidInputError(PROVIDER, 'MHI numbers are MHI, three digits and a W, WBB or P series number or twelve digits');
  }
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

function text($: CheerioAPI, element: Parameters<CheerioAPI>[0]): string {
  return $(element).text().replace(/\s+/g, ' ').trim();
}

/** An event's day and minute as one wall time. The page gives no zone. */
function wallClock(day: string, minute: string): string {
  const parsed = MINUTE.test(minute) ? DateTime.fromFormat(`${day} ${minute}`, `${DAY_FORMAT} HH:mm`, { zone: 'UTC', locale: 'en-GB' }) : null;
  // UTC only checks the calendar fields; no offset is assigned.
  if (!parsed?.isValid || parsed.year < 2000) throw new SchemaError(PROVIDER, 'MHI returned an invalid event time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The courier beside the link to its tracker, with its number when that differs. */
function onwardCourier($: CheerioAPI, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const blocks = $('.itemcarrier');
  if (blocks.length !== 1) return {};
  const reference = normalizeTrackingNumber(text($, blocks.find('strong').first())).toUpperCase();
  let url: URL;
  try {
    url = new URL(blocks.find('a[href]').first().attr('href') ?? '');
  } catch {
    return {};
  }
  // Only a courier the link's address names, for the number beside it, is a
  // hand-off. The link carries the recipient's postcode, so it is not kept.
  const partner = ['https:', 'http:'].includes(url.protocol) && PARTNER_NUMBER.test(reference) && url.href.toUpperCase().includes(reference)
    ? carrierIdFromPartner('', url.href) : undefined;
  if (!partner || partner === CARRIER || partner === 'unknown') return {};
  return { delivery_carrier: partner, ...(reference !== number ? { delivery_tracking_number: reference } : {}) };
}

/**
 * An untracked item's number at the destination's post, which the page offers
 * in place of a courier. The post that gave it serves the country its suffix
 * names, so that is where the item goes.
 */
function localPostNumber($: CheerioAPI): Pick<CarrierResult, 'delivery_tracking_number' | 'destination_country'> {
  const offered = $('.tracking-type-container').children('div').toArray()
    .some((element) => /\blocal poster number\b/i.test(text($, element)));
  if (!offered) return {};
  const numbers = $('.tracking-type-container .bg').toArray().map((element) => text($, element).toUpperCase())
    .filter((value) => isValidS10TrackingNumber(value));
  return numbers.length === 1 ? { delivery_tracking_number: numbers[0]!, destination_country: numbers[0]!.slice(-2) } : {};
}

/**
 * The tracking page MHI serves for a number. It echoes the number in its
 * search field and lists one row per event, newest first, each with a day, a
 * minute, a text, a category and a location. A number it does not know gets a
 * single row saying so, dated with the time of the search.
 *
 * Its own export scan comes first; the last-mile courier's scans follow, with
 * the courier's number beside a link to its tracker.
 */
export function parseMhi(html: string, raw: string): CarrierResult {
  const number = normalizeMhiNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'MHI answered with a browser check');
  const $ = load(html);
  const fields = $('input#Tracking');
  if (fields.length !== 1) throw new SchemaError(PROVIDER, 'MHI returned an unexpected page');
  if (normalizeTrackingNumber(fields.attr('value') ?? '').toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'MHI answered for another shipment');
  }
  const rows = $('fieldset[name="detailedInfo"] .item').toArray();
  if (rows.length === 1 && UNKNOWN.test(text($, $(rows[0]).find('.itemstatusinfo .itemkey')))) throw new NotFoundError(PROVIDER);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'MHI returned an oversized history');

  const statuses = rows.map((row, index) => {
    const cell = (selector: string) => {
      const found = $(row).find(selector);
      if (found.length !== 1) throw new SchemaError(PROVIDER, 'MHI returned an invalid event');
      return text($, found);
    };
    const local = wallClock(cell('.itemdateinfo .itemkey'), cell('.itemdateinfo .itemdetail'));
    const description = cell('.itemstatusinfo .itemkey');
    if (!description) throw new SchemaError(PROVIDER, 'MHI returned an event without a text');
    if (UNKNOWN.test(description)) throw new SchemaError(PROVIDER, 'MHI returned an unexpected page');
    const location = cell('.itemlocationinfo');
    const staged = mhiStage(description, cell('.itemstatusinfo .itemdetail'));
    const event: CarrierEvent = {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { local, index, event };
  });
  // Newest first; of equal clocks, the row higher on the page is the newer.
  statuses.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = statuses.map(({ event }) => event);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  const service = text($, $('.tracking-type-container .bg').first());
  const courier = onwardCourier($, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(/^(?:TRACKED|UNTRACKED)$/.test(service) ? { service_name: service === 'TRACKED' ? 'Tracked' : 'Untracked' } : {}),
    ...(courier.delivery_carrier ? courier : localPostNumber($)),
    events,
  };
}
