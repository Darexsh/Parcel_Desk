import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { foxpostScanStage } from './status.js';

export const PROVIDER = 'Foxpost';

// A Foxpost parcel ID, a Packeta number the tracker also answers for, the
// ten-digit IDs starting 66 it issues as well, and its home deliveries' numbers
// starting 66639, of up to the twenty characters its API allows a barcode.
const NUMBER = /^(?:CLFOX\d{15}|Z\d{10}|66\d{8}|66639\d{5,15})$/;
// The page's answer for a number it does not know.
const ABSENT = /^A megadott csomag azonosító nem található a rendszerünkben\b/;
const CLOCK = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/;
// The page of a Foxpost locker or pickup point.
const POINT_PAGE = /^\/~\/[A-Za-z0-9_-]{1,40}$/;
const ZONE = 'Europe/Budapest';
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

type Selection = ReturnType<CheerioAPI>;

/** A CLFOX parcel ID, a Z number, a ten-digit number starting 66 or a home delivery's 66639 number, as Foxpost's tracker takes them. */
export function normalizeFoxpostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Foxpost tracks CLFOX parcel IDs, Z numbers, ten-digit numbers starting 66 and home deliveries\' numbers starting 66639');
  }
  return number;
}

/** The page's clock ("2026.08.24 15:12") as a wall time. It carries no offset. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour),
    minute: Number(minute) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * A scan's instant from the page's clock, which the page renders at `readAt`
 * moved by Budapest's offset then less its offset at the scan. A scan in the
 * season the page is viewed in shows Budapest's wall clock, and a winter scan
 * viewed in summer an hour earlier: a CLFOX parcel's ID carries the second it
 * was created, which its first scan shows so. Null for a summer scan viewed in
 * winter, which no page has shown, and for a scan within hours of a clock change.
 */
function scanInstant(wall: string, readAt: Date): string | null {
  const view = DateTime.fromJSDate(readAt, { zone: ZONE }).offset;
  const shown = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  const [scan, ...around] = [0, -3, 3].map((hours) => shown.plus({ hours }).offset);
  if (scan === undefined || view < scan || around.some((offset) => offset !== scan)) return null;
  const local = DateTime.fromISO(wall, { zone: 'UTC' }).plus({ minutes: view - scan }).toISO({ includeOffset: false });
  return local ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toISO({ suppressMilliseconds: true }) : null;
}

/** The term of the parcel panel with this label, if the page shows it. */
function term($: CheerioAPI, label: string): Selection | null {
  const terms = $('.timeline-packet-info dt').filter((_, node) => clean($(node).text(), 80) === label);
  if (terms.length > 1) throw new SchemaError(PROVIDER, 'Foxpost repeated a parcel field');
  return terms.length ? terms.first() : null;
}

/** A scan's sentence, without the link to help pages after it. */
function sentenceOf(node: Selection): string {
  const description = node.find('.parcel-status-items__list-item-description').first().clone();
  description.find('a').remove();
  return clean(description.text(), 500);
}

/**
 * The tracker's reply for one parcel: its scans and the locker it waits at.
 * The page binds to the parcel by the number it shows; a number it does not
 * know returns the form with a notice instead.
 */
export function parseFoxpost(html: string, raw: string, readAt = new Date()): CarrierResult {
  const number = normalizeFoxpostNumber(raw);
  const $ = load(html);
  if ($('form#form-parcel-tracking').length !== 1) throw new IndeterminateError(PROVIDER, 'Foxpost did not return its tracking page');
  // The sentences are mapped in Hungarian, the page's only language for scans.
  if (!/^hu(?:-|$)/i.test($('html').attr('lang') ?? '')) throw new SchemaError(PROVIDER, 'Foxpost tracking page changed language');
  const shown = $('#parcel-number');
  const rows = $('ul.parcel-status-items__list > li');
  const notices = $('.warning-box');
  if (notices.length) {
    if (notices.length === 1 && !shown.length && !rows.length && ABSENT.test(clean(notices.text(), 300))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Foxpost returned a notice instead of the parcel');
  }
  if (!shown.length && !rows.length) throw new IndeterminateError(PROVIDER, 'Foxpost did not return a parcel');
  if (shown.length !== 1 || returnedTrackingNumber(shown.text()) !== number) {
    throw new SchemaError(PROVIDER, 'Foxpost returned a different parcel');
  }
  if ($('ul.parcel-status-items__list').length !== 1) throw new SchemaError(PROVIDER, 'Foxpost parcel history changed');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Foxpost returned too many scans');

  const scans: CarrierEvent[] = [];
  const seen = new Set<string>();
  rows.each((_, row) => {
    const node = $(row);
    const time = wallClock(clean(node.find('.parcel-status-items__list-item-date').first().text(), 32));
    if (!time) throw new SchemaError(PROVIDER, 'Foxpost returned an invalid scan time');
    const description = sentenceOf(node) || clean(node.find('.parcel-status-items__list-item-title').first().text(), 120);
    if (!description) throw new SchemaError(PROVIDER, 'Foxpost returned a scan without wording');
    const identity = `${time}\u0000${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = foxpostScanStage(description);
    scans.push({ local_time: time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  });
  // Newest first, as the page lists them; equal clocks keep the page's order.
  if (listsNewestFirst(scans) === false) scans.reverse();
  scans.sort((left, right) => right.local_time! > left.local_time! ? 1 : right.local_time! < left.local_time! ? -1 : 0);
  const events = scans.map((event) => {
    const time = typeof event.local_time === 'string' ? scanInstant(event.local_time, readAt) : null;
    if (!time) return event;
    const dated: CarrierEvent = { time, ...event };
    delete dated.local_time;
    return dated;
  });
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;

  const senderTerm = term($, 'Feladó');
  const sender = senderTerm ? clean(senderTerm.next('dd').text(), 200) : '';
  // The delivery method names the locker or point when the parcel goes to one,
  // with a link to its page. A delivered parcel was collected there when it
  // waited there last; a returned one no longer waits there.
  const methodTerm = term($, 'Kézbesítés módja');
  const link = methodTerm?.closest('.tracking-packet-info__row').find('.tracking-packet-info__action a').attr('href') ?? '';
  const atPoint = POINT_PAGE.test(link) && stage !== 'returned' && (stage !== 'delivered' || lastMovement(events) === 'ready_for_pickup');
  const point = atPoint && methodTerm ? clean(methodTerm.next('dd').text(), 200) : '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    ...(stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
