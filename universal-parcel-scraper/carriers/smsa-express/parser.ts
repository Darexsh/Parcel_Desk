import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { smsaStage } from './status.js';

export const PROVIDER = 'SMSA Express';
export const SMSA_ORIGIN = 'https://www.smsaexpress.com';
// The page is about 70 kB of site around a few kilobytes per day of scans.
export const SMSA_MAX_BYTES = 1_000_000;

const NUMBER = /^\d{12}$/;
// "#{number} This tracking number is not found, please check again later or contact the sender."
const NOT_FOUND = /^#(\S{1,64}) This tracking number is not found\b/;
// A firewall or bot check's page, which can come back with HTTP 200.
export const SMSA_BLOCKED = /<title>\s*(?:Web Page Blocked|Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|Attack ID:|Incapsula incident ID|The requested URL was rejected/i;
const DATE = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2}) ([AP]M)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?) KG$/;
// The delivery scan goes on with who signed for the parcel.
const SIGNER = /\s*,?\s*\bSigned by\b[\s\S]*$/i;
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){7,}(?!\d)/g;
export const SMSA_MAX_SCANS = 300;

/** An SMSA airway bill: twelve digits; anything else is not one it issues. */
export function normalizeSmsaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SMSA airway bills are twelve digits');
  return number;
}

/** A scan's wording without the signer after a delivery, or a phone number. */
export function smsaWording(text: string): string {
  return clean(clean(text, 300).replace(SIGNER, '').replace(PHONE, ''), 200).replace(/[\s,;:-]+$/, '');
}

/** The date in a `05-Oct-2026` heading, as `2026-10-05`, or null. */
function calendarDay(text: string): string | null {
  const match = DATE.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  if (!match || !month) return null;
  const day = DateTime.fromObject({ year: Number(match[3]), month, day: Number(match[1]) }, { zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

/** A `hh:mm AM` clock as `HH:mm`, or null. */
function clock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 1 || hour > 12 || Number(match[2]) > 59) return null;
  const hours = (hour % 12) + (match[3] === 'PM' ? 12 : 0);
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** What a page without a shipment says: SMSA's not-found notice, a block, or a changed page. */
function noShipment($: CheerioAPI, html: string, number: string): never {
  const details = $('#ticket-tracking-details');
  if (details.length === 1) {
    const notice = details.children('.no-results');
    if (notice.length === 1) {
      const echoed = NOT_FOUND.exec(clean(notice.text(), 300));
      if (!echoed) throw new IndeterminateError(PROVIDER, 'SMSA answered with a notice about the number');
      if (normalizeTrackingNumber(echoed[1]!) !== number) throw new IndeterminateError(PROVIDER, 'SMSA answered for another airway bill');
      throw new NotFoundError(PROVIDER);
    }
  }
  if (SMSA_BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SMSA answered with a block page');
  throw new SchemaError(PROVIDER, 'SMSA did not return a tracking page');
}

/** The value under one of the summary's labels ("Shipment Weight"), or an empty string. */
function labelled($: CheerioAPI, details: Cheerio<AnyNode>, label: string): string {
  const labels = details.find('.tracking-box-info span').filter((_, span) => clean($(span).text(), 60) === label);
  return labels.length === 1 ? clean(labels.next('p').text(), 120) : '';
}

/** The summary's weight, which the page shows as "380 KG", or " KG" when it has none. */
function weight(text: string): number | null {
  const kilograms = Number(WEIGHT.exec(text)?.[1]);
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/** The country code after the destination town ("Dammam, SA"). */
function destination(text: string): string | null {
  const code = /,\s*([A-Z]{2})$/.exec(text)?.[1];
  return code ? countryCode(code) : null;
}

/**
 * The page SMSA's tracker renders for one airway bill: the number, its
 * origin, newest status and destination, its weight, delivery estimate and
 * piece count, a progress rail and the scans, grouped under their day, newest
 * first. An unknown number gets the not-found notice in place of the shipment.
 * The page must name the airway bill asked.
 */
export function parseSmsa(html: string, raw: string): CarrierResult {
  const number = normalizeSmsaNumber(raw);
  const $ = load(html);
  const details = $('#ticket-tracking-details');
  const shown = details.find('.last-bold-fnt > p');
  if (details.length !== 1 || !shown.length) noShipment($, html, number);
  const airwayBill = clean(shown.text(), 200);
  if (shown.length !== 1 || !/^\d{6,20}$/.test(airwayBill)) throw new SchemaError(PROVIDER, 'SMSA did not name the airway bill');
  if (airwayBill !== number) throw new IndeterminateError(PROVIDER, 'SMSA answered for another airway bill');

  const timeline = details.find('.tracking-details-container');
  if (timeline.length !== 1) throw new SchemaError(PROVIDER, 'SMSA tracking page changed');
  const days = timeline.children('.row');
  if (days.find('.trk-wrap').length > SMSA_MAX_SCANS) throw new SchemaError(PROVIDER, 'SMSA returned too many scans');

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const node of days.toArray()) {
    const row = $(node);
    const heading = row.find('.date-wrap > h4');
    const day = heading.length === 1 ? calendarDay(clean(heading.text(), 40)) : null;
    if (!day) throw new SchemaError(PROVIDER, 'SMSA returned a day without a date');
    const scans = row.find('.trk-wrap');
    if (!scans.length) throw new SchemaError(PROVIDER, 'SMSA returned a day without scans');
    for (const scan of scans.toArray()) {
      const item = $(scan);
      const wording = item.children('h4');
      const description = wording.length === 1 ? smsaWording(wording.text()) : '';
      const time = clock(clean(item.find('.trk-wrap-content-left span').text(), 20));
      if (!description || !time) throw new SchemaError(PROVIDER, 'SMSA returned a scan without a clock or wording');
      // The day and minute of the scanning site's clock; the page names no zone.
      const local = `${day}T${time}:00`;
      const location = clean(item.find('.trk-wrap-content-right span').text(), 120);
      const identity = JSON.stringify([local, description, location]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const staged = smsaStage(description);
      events.push({
        local_time: local,
        description,
        ...(location ? { location } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      });
    }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const done = stage === 'delivered' || stage === 'returned';
  const estimate = calendarDay(labelled($, details, 'Expected Delivery Date'));
  const kilograms = weight(labelled($, details, 'Shipment Weight'));
  const country = destination(labelled($, details, 'To'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: done ? null : estimate,
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
