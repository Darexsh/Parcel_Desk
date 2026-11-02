import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { eushipmentsPlace, eushipmentsStage } from './status.js';

export const PROVIDER = 'euShipments';
export const CARRIER = 'eushipments';
// An order with a long history is under forty kilobytes.
export const EUSHIPMENTS_MAX_BYTES = 512 * 1024;

const NUMBER = /^[A-Z0-9]{6,40}$/;
// The reply's only error for a number the tracker does not know.
const UNKNOWN = 'Order with this number not found';
// "10 August, 2026 15:39": the status's clock, to the minute.
const CLOCK = /^\d{1,2} [A-Z][a-z]+, \d{4} \d{2}:\d{2}$/;
const CLOCK_FORMAT = 'd MMMM, yyyy HH:mm';
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 500;

/** A number for euShipments' tracker: its own or the last-mile courier's. */
export function normalizeEushipmentsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'euShipments numbers are six to forty letters and digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** A status's date and minute as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const parsed = CLOCK.test(text) ? DateTime.fromFormat(text, CLOCK_FORMAT, { zone: 'UTC', locale: 'en' }) : null;
  // UTC only checks the calendar fields; no offset is assigned. Only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.year < 2000 || ![CLOCK_FORMAT, `d${CLOCK_FORMAT}`].some((format) => parsed.toFormat(format, { locale: 'en' }) === text)) {
    throw new SchemaError(PROVIDER, 'euShipments returned an invalid status time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The tracker's JSON reply when it has no order to show: an error on the
 * number field. Only its unknown-number error is a missing parcel.
 */
export function parseEushipmentsError(payload: unknown): never {
  const errors = payload && typeof payload === 'object' ? (payload as { errors?: unknown }).errors : undefined;
  const message = errors && typeof errors === 'object' ? (errors as { tracking_number?: unknown }).tracking_number : undefined;
  if (message === UNKNOWN) throw new NotFoundError(PROVIDER);
  if (typeof message === 'string') throw new IndeterminateError(PROVIDER, 'euShipments refused the lookup');
  throw new SchemaError(PROVIDER, 'euShipments returned an unexpected reply');
}

/** The last-mile courier from its tracking link, with its number when that differs. */
function lastMile($: ReturnType<typeof load>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const rows = new Map($('div.order-last-mile p').map((_, element) => {
    const label = clean($(element).find('span.order-last-mile-label').text(), 40);
    return [[label, $(element)]] as const;
  }).get());
  const reference = normalizeTrackingNumber(clean(rows.get('Tracking Number:')?.clone().children('span').remove().end().text() ?? '', 64)).toUpperCase();
  const href = rows.get('Tracking Link:')?.find('a').attr('href') ?? '';
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return {};
  }
  // Only a courier the link's address names, for the number in the link, is a hand-off.
  const partner = ['https:', 'http:'].includes(url.protocol) && NUMBER.test(reference) && url.href.toUpperCase().includes(reference)
    ? carrierIdFromPartner('', url.href) : undefined;
  if (!partner || partner === CARRIER || partner === 'unknown') return {};
  return { delivery_carrier: partner, ...(reference !== number ? { delivery_tracking_number: reference } : {}) };
}

/**
 * The order history euShipments' tracker returns for a number: a heading that
 * names the number searched, a table of statuses, oldest first, each with its
 * clock and the last-mile courier's own wording, and then the courier's name,
 * number and tracking link once a courier has the parcel.
 *
 * The heading must name the whole number asked. The courier's wording is not
 * read: the status says the same in English, and the courier's own tracker
 * gives its wording.
 */
export function parseEushipments(html: string, raw: string): CarrierResult {
  const number = normalizeEushipmentsNumber(raw);
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'euShipments answered with a browser check');
  const $ = load(html);
  const headings = $('.order-number');
  const tables = $('div.order-detail-table');
  if (headings.length !== 1 || tables.length !== 1 || tables.children('div.order-detail-table-heading').length !== 1) {
    throw new SchemaError(PROVIDER, 'euShipments returned an unexpected page');
  }
  const searched = /^N (\S+)$/.exec(clean(headings.children('span').text(), 80));
  if (!searched) throw new SchemaError(PROVIDER, 'euShipments returned an unexpected page');
  if (normalizeTrackingNumber(searched[1]!).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'euShipments answered for another shipment');

  const rows = tables.children('div.order-detail-table-row');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'euShipments returned an oversized history');
  const seen = new Set<string>();
  const statuses: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.each((index, element) => {
    const row = $(element);
    const time = row.find('p.order-time-p');
    const status = row.find('p.order-status-p');
    if (time.length !== 1 || status.length !== 1 || row.find('p.order-info-p').length !== 1) {
      throw new SchemaError(PROVIDER, 'euShipments returned an invalid status');
    }
    const description = clean(status.text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'euShipments returned a status without wording');
    const local = wallClock(clean(time.text(), 60));
    // A row the page lists twice is kept once.
    const identity = JSON.stringify([local, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const { place, country } = eushipmentsPlace(description);
    const location = [place, country].filter(Boolean).join(', ');
    const staged = eushipmentsStage(description);
    statuses.push({ local, index, event: {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // Newest first; of equal clocks, the row further down the page is the newer.
  statuses.sort((left, right) => right.local.localeCompare(left.local) || right.index - left.index);
  const events = statuses.map(({ event }) => event);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...lastMile($, number),
    events,
  };
}
