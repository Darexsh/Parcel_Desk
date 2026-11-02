import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { vrlMappedStage, vrlStage } from './status.js';

export const PROVIDER = 'VRL Logistics';
// The page is under a hundred kilobytes, most of it menus and styles.
export const VRL_MAX_BYTES = 1024 * 1024;

const NUMBER = /^\d{9,10}$/;
const DAY = /^\d{2}-[A-Z][a-z]{2}-\d{4}$/;
const DAY_FORMAT = 'dd-LLL-yyyy';
// A scan's clock as the page writes it, "19:03, 06-Mar-2026": the hour, then the month where the minutes belong.
const SCAN_CLOCK = /^([01]\d|2[0-3]):[0-5]\d, (\S+)$/;
// The page's answer for an LR number it does not know, in an error toast above the form.
const NO_DATA = 'No data found';
// The toast for an LR number the tracker refuses outright, also its answer to a request without one.
const INVALID = /^Invalid LR number\b/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
// The ends of the progress rail: the booking day at the origin, the delivery day at the destination.
const MARKERS = new Set(['ORIGIN', 'DESTINATION']);
const MAX_ROWS = 500;

/** An LR (lorry receipt) number: nine or ten digits. Anything else is not a number VRL issues. */
export function normalizeVrlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'VRL LR numbers are nine or ten digits');
  return number;
}

/** A day as the page writes it, "06-Mar-2026", as an ISO calendar day. */
function calendarDay(text: string): string {
  // Parsing in UTC checks the calendar alone; a day that reads back changed is not one.
  const parsed = DateTime.fromFormat(text, DAY_FORMAT, { zone: 'UTC', locale: 'en-US' });
  if (!DAY.test(text) || !parsed.isValid || parsed.toFormat(DAY_FORMAT, { locale: 'en-US' }) !== text) {
    throw new SchemaError(PROVIDER, 'VRL returned an invalid date');
  }
  return parsed.toISODate();
}

/** The labelled values of a card section, by label. */
function labelled($: CheerioAPI, section: Cheerio<Element>): Map<string, string> {
  const values = new Map<string, string>();
  section.find('p.track-label').each((_, node) => {
    const value = $(node).next('p.track-value');
    if (value.length) values.set(clean($(node).text(), 80), clean(value.text(), 120));
  });
  return values;
}

interface Row { event: CarrierEvent; day: string; index: number }

/** The rail's scans in the page's order, oldest first, without its two ends and the rows that have no date. */
function scansOf($: CheerioAPI, timeline: Cheerio<Element>): Row[] {
  const rails = timeline.find('div.track-container.sm-scr-progress');
  if (rails.length !== 1) throw new SchemaError(PROVIDER, 'VRL returned a page without its transit rail');
  const steps = rails.children('div.track-stepp');
  if (steps.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'VRL returned an oversized history');
  const rows: Row[] = [];
  steps.each((index, node) => {
    const content = $(node).children('div.step-content');
    const code = clean(content.find('div.step-labell div.status').text(), 40);
    const clock = content.children('div.step-date');
    if (!clock.length) {
      if (!MARKERS.has(code)) throw new SchemaError(PROVIDER, 'VRL returned a transit row without its date');
      return;
    }
    const written = clean(clock.text(), 40);
    // The page can list a row with neither a time nor a day, as ", ".
    if (/^,?$/.test(written)) return;
    const match = SCAN_CLOCK.exec(written);
    if (!match) throw new SchemaError(PROVIDER, 'VRL returned an invalid scan time');
    const description = clean(content.children('label').first().text(), 120);
    const location = clean(content.find('div.step-labell div.city').text(), 120);
    if (!description || !location) throw new SchemaError(PROVIDER, 'VRL returned a transit row without its status or branch');
    const day = calendarDay(match[2]!);
    rows.push({ event: { local_time: day, location, description }, day, index });
  });
  return rows;
}

/**
 * The page `POST /Tracking/TrackShipment` answers for one LR number. The
 * server renders the consignment's details card (its number, booking branch,
 * destination branch, booking day and delivery type), then a transit card with
 * its current status and a rail of its scans between the booking and the
 * destination, oldest first, in two layouts: wide screens and phones. The
 * phone layout is read. A hidden sample card ships with every page. An LR
 * number the tracker does not know comes back as the form with an error toast.
 */
export function parseVrl(html: string, raw: string): CarrierResult {
  const number = normalizeVrlNumber(raw);
  const $ = load(html);
  const details = $('section.track-card--details').not('.d-none');
  const timeline = $('section.track-card--timeline').not('.d-none');
  if (!details.length && !timeline.length) {
    const toast = clean($('#errorToast .toast-body').text(), 200);
    if (toast === NO_DATA) throw new NotFoundError(PROVIDER);
    // A nine- or ten-digit number is one the tracker takes: a refusal means the request changed.
    if (INVALID.test(toast)) throw new SchemaError(PROVIDER, 'VRL refused the LR number as invalid');
    if (!$('#trackingForm').length && CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'VRL answered with a browser check');
    throw new SchemaError(PROVIDER, 'VRL returned a page without an answer');
  }
  if (details.length !== 1 || timeline.length !== 1) throw new SchemaError(PROVIDER, 'VRL returned an unexpected number of consignments');
  const heading = details.find('#lrnum');
  if (heading.length !== 1) throw new SchemaError(PROVIDER, 'VRL returned a consignment without its number');
  const echoed = clean(heading.text(), 40).replace(/^#\s*/, '');
  if (echoed !== number) throw new SchemaError(PROVIDER, 'VRL answered for a different LR number');

  const booking = labelled($, details);
  const transit = labelled($, timeline);
  if (!booking.has('Booking Date') || !booking.has('Booking From')) throw new SchemaError(PROVIDER, 'VRL returned a consignment without its booking');
  const rows = scansOf($, timeline);
  const bookedOn = booking.get('Booking Date')!;
  const bookedAt = booking.get('Booking From')!;
  // The rail starts with the booking day at the first word of the booking branch's name; the details card names it whole.
  if (bookedOn) {
    const day = calendarDay(bookedOn);
    rows.unshift({ event: { local_time: day, ...(bookedAt ? { location: bookedAt } : {}), description: 'Booked' }, day, index: -1 });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Days in order; within a day, the page's order. Without the hour, a row the
  // same day at the same branch with the same status says nothing new.
  const ordered = rows.sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index).reverse();
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { event } of ordered) {
    const key = JSON.stringify([event.local_time, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = vrlStage(event.description!);
    events.push({ ...event, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  // The transit card's current status decides when the map knows it; else the newest scan with a stage.
  const summary = transit.get('Current Status') ?? '';
  const summarized = summary ? vrlMappedStage(summary) : undefined;
  const decider = summarized ? undefined : events.find((event) => event.stage);
  const stage = (summarized ?? decider?.stage) as Stage | undefined;
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: summarized ? 'carrier_map' : decider!.stage_source! } : {}),
    last_status_text: summarized ? summary : newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
