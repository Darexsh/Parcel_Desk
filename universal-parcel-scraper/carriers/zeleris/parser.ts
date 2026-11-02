import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { zelerisQuiet, zelerisRailStage, zelerisStage } from './status.js';

export const PROVIDER = 'Zeleris';
// The page is about 260 kB of site around a few kilobytes of tracking.
export const ZELERIS_MAX_BYTES = 1_000_000;
export const ZELERIS_ORIGIN = 'https://www.zeleris.com';

// Eight hexadecimal characters, nine digits and a letter.
const NUMBER = /^[0-9A-F]{8}\d{9}[A-Z]$/;
const ORDER = /^Pedido ([0-9A-Z]{1,40})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
// The delivered step names its date and time after its label.
const RAIL_STAMP = /\s+\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Web Page Blocked|Request Rejected|Access Denied|Attention Required|Just a moment)|_cf_chl_opt|cf-turnstile|Attack ID:/i;
const MAX_ROWS = 300;

/**
 * How far along a stage is, to compare the rail's current step with the
 * newest scan. A delivery or a return is final.
 */
const PROGRESS: Partial<Record<Stage, number>> = {
  registered: 1, accepted: 2, in_transit: 3, customs: 3, out_for_delivery: 4, ready_for_pickup: 4,
  failed_attempt: 5, exception: 6, delivered: 7, returned: 7,
};

/** A Zeleris code as its tracker takes it: eight hexadecimal characters, nine digits and a letter. */
export function normalizeZelerisNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Zeleris tracks codes of eight hexadecimal characters, nine digits and a letter');
  return number;
}

/**
 * What identifies a shipment in its code. The first eight characters are a
 * nine-digit number in hexadecimal whose third to seventh digits are a day of
 * the year and a year. Zeleris ignores those five digits in a lookup and prints
 * the code with its own admission date, which can be a day after the label's.
 */
function shipmentKey(number: string): string {
  const prefix = String(Number.parseInt(number.slice(0, 8), 16)).padStart(9, '0');
  return prefix.length === 9 ? `${prefix.slice(0, 2)}:${prefix.slice(7)}:${number.slice(8)}` : number;
}

/** A row's date ("16/07/2026") and clock ("19:35") as one wall time. The page gives no offset. */
function wallClock(day: string, time: string): string | null {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  if (!date || !clock) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(date[3]), month: Number(date[2]), day: Number(date[1]),
    hour: Number(clock[1]), minute: Number(clock[2]) }, { zone: 'UTC' });
  return parsed.isValid && Number(clock[1]) < 24 ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** The rail's current step, without the delivery's date and time. */
function railStep(root: ReturnType<CheerioAPI>): string | null {
  const active = root.find('.zeleris-shipping-tracking-detail-status-content > .zeleris-shipping-box-icon-content.active');
  if (active.length !== 1) return null;
  const label = clean(active.find('.zeleris-shipping-box-icon-label > span').first().text(), 120).replace(RAIL_STAMP, '');
  return label || null;
}

/**
 * Where a lookup's redirect sends the visitor. Zeleris sends a number it does
 * not know, and a lookup its system could not answer, back to the search page
 * with the number and a flag.
 */
export function parseZelerisRedirect(location: string | null, raw: string, html?: string): never {
  const number = normalizeZelerisNumber(raw);
  if (html && BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Zeleris answered with a block page');
  let target: URL | null;
  try {
    target = location ? new URL(location, ZELERIS_ORIGIN) : null;
  } catch {
    target = null;
  }
  const search = target?.origin === ZELERIS_ORIGIN && target.pathname === '/seguimiento-de-envios/' ? target.searchParams : null;
  if (search && normalizeTrackingNumber(search.get('tracking_number') ?? '') === number) {
    // "El envío no existe. Por favor, verifique el número e inténtelo de nuevo."
    if (search.get('not_found') === '1' && !search.has('tracking_error')) throw new NotFoundError(PROVIDER);
    // "Ups, estamos teniendo un problema técnico."
    if (search.get('tracking_error') === '1') throw new IndeterminateError(PROVIDER, 'Zeleris could not look the shipment up');
  }
  throw new IndeterminateError(PROVIDER, 'Zeleris sent the lookup to another page');
}

/**
 * The tracker's page for one shipment: the code it answers for, the progress
 * rail and the messages it shows the recipient, newest first, each with its
 * date and time. The page names no place, sender or recipient.
 */
export function parseZeleris(html: string, raw: string): CarrierResult {
  const number = normalizeZelerisNumber(raw);
  const $ = load(html);
  const roots = $('div.zeleris-shipping-tracking-detail');
  if (roots.length > 1) throw new SchemaError(PROVIDER, 'Zeleris tracking page changed');
  if (!roots.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Zeleris answered with a block page');
    if ($('form input[name="tracking_number"]').length) throw new IndeterminateError(PROVIDER, 'Zeleris returned its search page');
    throw new SchemaError(PROVIDER, 'Zeleris did not return a tracking page');
  }
  const root = roots.first();
  const descriptions = root.find('.zeleris-shipping-tracking-detail-description');
  const order = ORDER.exec(clean(descriptions.text(), 80));
  if (descriptions.length !== 1 || !order) throw new SchemaError(PROVIDER, 'Zeleris did not name the shipment');
  const shown = order[1]!;
  if (shown !== number && !(NUMBER.test(shown) && shipmentKey(shown) === shipmentKey(number))) {
    throw new SchemaError(PROVIDER, 'Zeleris answered for a different number');
  }

  const rows = root.find('.zeleris-shipping-tracking-detail-body-content > .zeleris-shipping-tracking-row');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Zeleris returned too many scans');
  const scans: { event: CarrierEvent; index: number }[] = [];
  const seen = new Set<string>();
  rows.each((index, node) => {
    const row = $(node);
    const day = row.children('.zeleris-shipping-tracking-col-date');
    const time = row.children('.zeleris-shipping-tracking-col-time');
    const text = row.children('.zeleris-shipping-tracking-col-description');
    if (day.length !== 1 || time.length !== 1 || text.length !== 1) throw new SchemaError(PROVIDER, 'Zeleris history columns changed');
    const local = wallClock(clean(day.text(), 20), clean(time.text(), 10));
    const description = clean(text.text(), 400);
    if (!local || !description) throw new SchemaError(PROVIDER, 'Zeleris returned a scan without a clock or wording');
    const event: CarrierEvent = { local_time: local, description };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = zelerisStage(description);
    if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
    scans.push({ event, index });
  });
  // Newest first; equal clocks keep the page's order.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : left.index - right.index);
  const events = scans.map(({ event }) => event);

  // The rail's current step is the shipment's state, which can move ahead of
  // the recipient's messages (a parcel at its destination depot with only its
  // admission shown) or stay behind them (in transit on a delivery round's
  // morning). The one further along is the shipment's stage.
  const step = railStep(root);
  const railStage = step ? zelerisRailStage(step) : undefined;
  // A text message to the recipient moves nothing.
  const scanned = events.find(event => !zelerisQuiet(event.description!));
  const scanStage = scanned?.stage as Stage | undefined;
  const fromRail = Boolean(railStage && (!scanStage || PROGRESS[railStage]! > PROGRESS[scanStage]!));
  const stage = fromRail ? railStage : scanStage;
  const canonical = shown !== number ? { canonical_tracking_number: shown } : {};

  if (!events.length) {
    if (!railStage) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(railStage), current_stage: railStage, current_stage_source: 'carrier_map',
      last_status_text: step, last_update: null, expected_delivery: null, ...canonical, summary_only: true, events: [],
    };
  }
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromRail ? 'carrier_map' : scanned!.stage_source } : {}),
    last_status_text: fromRail ? step : newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...canonical,
    events,
  };
}
