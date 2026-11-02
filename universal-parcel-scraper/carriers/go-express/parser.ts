import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { goExpressStage } from './status.js';

export const PROVIDER = 'GO! Express';
// A shipment's reply is about 8 kB, the notice for an unknown one about 1 kB.
export const GO_EXPRESS_MAX_BYTES = 512 * 1024;

// GO!'s waybill (HWB) numbers, as its tracker, labels and notification links show them.
const NUMBER = /^\d{12}$/;
// The tracker's answer, in English, for a waybill it has no shipment for.
const NOT_FOUND = 'We have not yet received the shipment with the specified tracking ID';
// "Waybill-No.: 012345678901" heads a shipment.
const WAYBILL = /^Waybill-No\.:\s*(\S{1,40})$/;
// The English page dates its rows "Jun 24, 2026" and "1:16:00 pm".
const DAY = /^([A-Z][a-z]{2,3}) (\d{1,2}), (\d{4})$/;
const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2}) ([ap]m)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;
const MAX_ROWS = 500;

/** A GO! waybill: twelve digits. Anything else is not a number GO! issues. */
export function normalizeGoExpressNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GO! Express tracks twelve-digit waybill numbers');
  return number;
}

/** A row's day and clock as one wall time. The page gives no offset. */
function wallClock(day: string, time: string): string | null {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  if (!date || !clock) return null;
  const month = MONTHS.indexOf(date[1]!.slice(0, 3).toLowerCase()) + 1;
  // September is "Sep" in English; a four-letter month must be "Sept".
  if (!month || (date[1]!.length === 4 && date[1] !== 'Sept')) return null;
  const twelve = Number(clock[1]);
  if (twelve < 1 || twelve > 12) return null;
  const hour = (twelve % 12) + (clock[4]!.toLowerCase() === 'pm' ? 12 : 0);
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(date[3]), month, day: Number(date[2]),
    hour, minute: Number(clock[2]), second: Number(clock[3]) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** The waybill the reply's "Copy Link" button links to, the number the tracker looked up. */
function linkedNumber($: CheerioAPI): string | null {
  const links = $('.tracking__buttons .tracking__btn-copy-link[data-link]');
  if (links.length !== 1) return null;
  try {
    const reference = new URL(links.attr('data-link') ?? '').searchParams.getAll('reference');
    return reference.length === 1 ? returnedTrackingNumber(reference[0]) : null;
  } catch {
    return null;
  }
}

interface Row { local_time: string; description: string; location?: string; error: boolean; index: number }

/**
 * GO!'s tracking reply for one waybill: an HTML fragment its tracking page
 * inserts. A shipment comes with its waybill number, its current status and its
 * history, newest first, each row a wording, a day, a clock and the station or
 * hub. A waybill the tracker has no shipment for gets a notice instead. Both
 * end with a link to the shipment's tracking page, which binds the reply to the
 * requested number. The progress rail, the responsible station's contact
 * details and the postcode form are never read.
 */
export function parseGoExpress(html: string, rawNumber: string): CarrierResult {
  const number = normalizeGoExpressNumber(rawNumber);
  const $ = load(html);
  const roots = $('div.tracking');
  if (roots.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GO! Express answered with a block page');
    throw new SchemaError(PROVIDER, 'GO! Express did not return a tracking reply');
  }
  const bound = () => {
    const linked = linkedNumber($);
    if (linked === null) throw new SchemaError(PROVIDER, 'GO! Express returned a reply without its tracking link');
    if (linked !== number) throw new SchemaError(PROVIDER, 'GO! Express answered for a different number');
  };

  const box = roots.find('.tracking__box > span.p2');
  if (!box.length) {
    const alerts = roots.find('.alert');
    const notice = alerts.length === 1 ? clean(alerts.find('h2').first().text(), 200) : '';
    if (notice === NOT_FOUND) {
      bound();
      throw new NotFoundError(PROVIDER);
    }
    if (alerts.length) throw new IndeterminateError(PROVIDER, 'GO! Express answered with another notice');
    throw new SchemaError(PROVIDER, 'GO! Express returned a reply without a shipment or a notice');
  }
  bound();
  const waybill = box.length === 1 ? WAYBILL.exec(clean(box.text(), 80))?.[1] : undefined;
  if (!waybill) throw new SchemaError(PROVIDER, 'GO! Express returned a shipment without its waybill');
  if (normalizeTrackingNumber(waybill) !== number) throw new SchemaError(PROVIDER, 'GO! Express answered for a different number');

  const lists = roots.find('ul.tracking__history-list');
  if (lists.length > 1) throw new SchemaError(PROVIDER, 'GO! Express shipment history changed');
  const items = lists.children('li.tracking__history-list-item');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GO! Express returned too many scans');
  const rows: Row[] = [];
  const seen = new Set<string>();
  items.each((index, element) => {
    const item = $(element);
    const fields = item.children('.tracking__history-description');
    const field = (name: string) => {
      const found = fields.children(name);
      return found.length === 1 ? clean(found.text(), 300) : null;
    };
    const description = field('.tracking__history-title');
    const day = field('time.tracking__history-date');
    const time = field('time.tracking__history-time');
    const location = field('.tracking__history-location') ?? '';
    if (fields.length !== 1 || !description || day === null || time === null) {
      throw new SchemaError(PROVIDER, 'GO! Express returned a scan without its fields');
    }
    const local = wallClock(day, time);
    if (!local) throw new SchemaError(PROVIDER, 'GO! Express returned an invalid scan time');
    // A delivery is listed once per remark the page no longer shows, and
    // packages travelling together share their scans.
    const identity = JSON.stringify([local, description, location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    rows.push({ local_time: local, description, ...(location ? { location } : {}),
      error: item.children('.tracking__history-status').hasClass('tracking-status--error'), index });
  });
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first; equal clocks keep the page's order.
  rows.sort((left, right) => left.local_time > right.local_time ? -1 : left.local_time < right.local_time ? 1 : left.index - right.index);
  const events: CarrierEvent[] = rows.map(row => {
    const classified = goExpressStage(row.description, row.error);
    return { local_time: row.local_time, description: row.description, ...(row.location ? { location: row.location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
  });
  const latest = events[0]!;
  const decider = events.find(event => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
