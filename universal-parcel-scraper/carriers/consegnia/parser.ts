import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { consegniaStage } from './status.js';

export const PROVIDER = 'Consegnia Logistics';
export const CARRIER = 'consegnia';
// The tracking page is about 20 kB and a reply with its history a few.
export const CONSEGNIA_MAX_BYTES = 256 * 1024;

// CLC and nine digits, as its tracker prints them.
const NUMBER = /^CLC\d{9}$/;
const MONTHS = new Map(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((month, index) => [month, index + 1]));
// "Nov 18, 2025" and "06:05 PM": a wall clock with no zone.
const DAY = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2}) ([AP]M)$/;
const DAY_AND_TIME = /^(.+, \d{4}) (\d{1,2}:\d{2} [AP]M)$/;
// The token Laravel puts in the page's form for its session.
const TOKEN = /^[A-Za-z0-9]{20,128}$/;
// Firewall and bot-check pages that could stand in for the page or the lookup's JSON. Cloudflare's
// script for its challenge platform also runs on the ordinary page, so this is read only where the
// page's form or the lookup's JSON is missing.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The lookup's answer to a number it does not hold.
const NOT_FOUND = /^No information about your package\b/;
const MAX_EVENTS = 200;

/** A number for Consegnia's tracker: CLC and nine digits. */
export function normalizeConsegniaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Consegnia tracking numbers are CLC and nine digits');
  return number;
}

/** A firewall or bot-check page in place of the tracking page or the lookup's JSON. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** The token the tracking page's form sends with a number, or null when the page has none. */
export function consegniaToken(html: string): string | null {
  const $ = load(html);
  const token = clean($('form#track-form input[name="_token"]').attr('value'), 200) || clean($('meta[name="csrf-token"]').attr('content'), 200);
  return TOKEN.test(token) ? token : null;
}

/** A day the tracker prints, "Nov 18, 2025", as `YYYY-MM-DD`. */
function dayOf(text: string): string {
  const match = DAY.exec(text);
  const month = match ? MONTHS.get(match[1]!) : undefined;
  const date = match && month && Number(match[3]) >= 2000 ? calendarDay(Number(match[3]), month, Number(match[2])) : null;
  if (!date) throw new SchemaError(PROVIDER, 'Consegnia returned an invalid scan time');
  return date;
}

/** A day and a time of day on twelve hours, "06:05 PM", as one wall time. The tracker names no zone. */
function wallClock(day: string, time: string): string {
  const date = dayOf(day);
  const match = TIME.exec(time);
  const hour = match ? Number(match[1]) : 0;
  if (!match || hour < 1 || hour > 12 || Number(match[2]) > 59) throw new SchemaError(PROVIDER, 'Consegnia returned an invalid scan time');
  const hours = (hour % 12) + (match[3] === 'PM' ? 12 : 0);
  return `${date}T${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

/** The summary's fields by their label, lower case. */
function summaryFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of $('dl.track-details > .track-details__row').toArray()) {
    const name = clean($(row).children('dt').text(), 40).toLowerCase();
    const value = clean($(row).children('dd').text(), 200);
    if (name && !fields.has(name)) fields.set(name, value);
  }
  return fields;
}

type Selection = ReturnType<CheerioAPI>;

/** A history row: its day and time, its status and the reason shown beside a failed delivery. */
function scan($: CheerioAPI, item: Selection): CarrierEvent {
  const clock = item.children('.track-timeline__date').children('span').toArray().map((span) => clean($(span).text(), 40));
  const content = item.children('.track-timeline__content');
  const status = clean(content.children('.track-timeline__status').text(), 120);
  if (clock.length !== 2 || !status) throw new SchemaError(PROVIDER, 'Consegnia returned an invalid history row');
  const reasons = [...new Set(content.find('.track-pill').toArray().map((pill) => clean($(pill).text(), 160)).filter(Boolean))];
  const staged = consegniaStage(status);
  return {
    local_time: wallClock(clock[0]!, clock[1]!),
    description: reasons.length ? `${status}: ${reasons.join(', ')}` : status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The lookup's reply for one number, `{ success, data: { html } }`: a fragment
 * its server renders with the number, the current status, the last update, the
 * booking day, the delivery clock once delivered, and the history, newest
 * first, each row a status, the reason for a failed delivery and a wall clock
 * to the minute with no zone. It names no person, place or phone number.
 *
 * The fragment must carry the whole number asked. The delivery clock is not
 * read: a delivered parcel's newest row gives it, and it has no zone either.
 */
export function parseConsegnia(payload: unknown, raw: string): CarrierResult {
  const number = normalizeConsegniaNumber(raw);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data) || typeof payload.data.html !== 'string') {
    throw new SchemaError(PROVIDER, 'Consegnia returned an unexpected reply');
  }
  const $ = load(payload.data.html);
  const shown = $('.track-card__awb');
  if (shown.length !== 1) throw new SchemaError(PROVIDER, 'Consegnia returned a shipment without its number');
  if (normalizeTrackingNumber(clean(shown.text(), 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Consegnia answered for another shipment');
  }
  const fields = summaryFields($);
  const summary = clean(fields.get('current status'), 120);
  if (!summary) throw new SchemaError(PROVIDER, 'Consegnia returned a shipment without its status');
  const rows = $('ol.track-timeline').children('li.track-timeline__item').toArray();
  if (rows.length > MAX_EVENTS || (!rows.length && !$('.track-card__empty').length)) {
    throw new SchemaError(PROVIDER, 'Consegnia returned an invalid history');
  }

  // Newest first, as the tracker lists them: the sort keeps rows of one minute in its order.
  const events = rows.map((row) => scan($, $(row))).sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  // The summary is the carrier's current status; the newest staged row decides only one no rule reads.
  const staged = events.find((event) => event.stage);
  const current = consegniaStage(summary) ?? (staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null);
  const state = current
    ? { status: languageStageStatus(current.stage), current_stage: current.stage, current_stage_source: current.source }
    : { status: 'unknown' as const };

  const newest = events[0];
  if (!newest) {
    // A shipment with a status and no history yet, dated by its last update, else its booking day.
    if (!current) throw new NoHistoryError(PROVIDER);
    const update = DAY_AND_TIME.exec(fields.get('last update') ?? '');
    const booked = fields.get('booked on');
    const clock = update ? wallClock(update[1]!, update[2]!) : booked ? dayOf(booked) : null;
    return {
      ...state, last_status_text: summary, last_update: null, ...(clock ? { last_update_local: clock } : {}),
      expected_delivery: null, summary_only: true, events: [],
    };
  }
  return { ...state, last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time!, expected_delivery: null, events };
}

/**
 * The lookup's answer to a number it does not hold: HTTP 404 with `success`
 * false and its message. The message does not quote the number. Any other 404
 * is a missing route.
 */
export function isUnknownShipment(body: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(payload) && payload.success === false && NOT_FOUND.test(clean(payload.message, 300));
}

/** The lookup's reply as JSON, or the reason it is not one. */
export function consegniaJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBlockPage(body)) throw new ChallengeError(PROVIDER, 'Consegnia answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Consegnia returned a reply that is not JSON', { cause });
  }
}
