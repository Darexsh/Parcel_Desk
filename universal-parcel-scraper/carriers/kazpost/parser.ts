import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isHiddenKazpostCode, kazpostStage, kazpostUndone, kazpostWording } from './status.js';

export const PROVIDER = 'Kazpost';
// A summary is under 2 kB, and a long history about 20 kB.
export const KAZPOST_MAX_BYTES = 1_000_000;

const MAX_DAYS = 1_000;
const MAX_ROWS = 2_000;
// The tracker's answer for a number its records do not hold, naming that
// number, in the language the request asks for: Russian, Kazakh or English.
const NOT_FOUND = [
  /^Отсутствует информация по данному трек номеру ([A-Z0-9]+)\./i,
  /^Бұл ([A-Z0-9]+) трек нөмірі бойынша ақпарат жоқ\./i,
  /^There is no information on this tracking number ([A-Z0-9]+)\./i,
];
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|ddos-guard|captcha/i;
const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/**
 * The tracker looks up S10 item codes: Kazpost's own, ending KZ, and those of
 * the posts that send items to Kazakhstan. The code needs a valid check digit.
 */
export function normalizeKazpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Kazpost tracks S10 item codes');
}

/** A reply's JSON. Anything else is a block page or a changed service. */
export function kazpostJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kazpost answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Kazpost returned a reply that is not JSON', { cause });
  }
}

/**
 * The reply's own item number. A reply with an `error` is the tracker's
 * notice; only the one for a number its records do not hold, naming this
 * number, is a missing item.
 */
function replyFor(reply: unknown, number: string, part: string): Record<string, unknown> {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, `Kazpost returned an invalid ${part}`);
  const trackid = returnedTrackingNumber(reply.trackid);
  if (reply.error !== undefined && reply.error !== null && reply.error !== '') {
    const error = clean(reply.error, 400);
    const named = NOT_FOUND.map(notice => notice.exec(error)).find(Boolean);
    if (!named) throw new IndeterminateError(PROVIDER, 'Kazpost did not complete the lookup');
    if (normalizeTrackingNumber(named[1]!) !== number || (trackid && trackid !== number)) {
      throw new SchemaError(PROVIDER, 'Kazpost answered for a different item');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (trackid !== number) throw new SchemaError(PROVIDER, 'Kazpost answered for a different item');
  return reply;
}

interface Summary {
  status: string;
  code: string;
  weight?: number;
  country?: string;
}

/**
 * The item's summary: its status and the code behind it, its weight in
 * kilograms and the receiver's country. Names, addresses, phone numbers and
 * postcodes are left out.
 */
function summaryOf(reply: unknown, number: string): Summary {
  const summary = replyFor(reply, number, 'summary');
  const weight = summary.weight;
  const receiver = isRecord(summary.receiver) ? summary.receiver : {};
  const country = countryCode(receiver.country);
  return {
    status: clean(summary.status, 200),
    code: clean(summary.status_code, 60),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? { weight } : {}),
    ...(country ? { country } : {}),
  };
}

interface Scan {
  code: string;
  local: string;
  name: string;
  address: string;
  index: number;
}

/** A scan's date ("26.01.2026") and time ("15:19:24"): the office's wall clock, with no zone. */
function wallClock(date: unknown, time: unknown): string {
  const day = clean(date, 16);
  const clock = clean(time, 16);
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = DATE.test(day) && TIME.test(clock)
    ? DateTime.fromFormat(`${day} ${clock}`, 'dd.MM.yyyy HH:mm:ss', { zone: 'UTC' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Kazpost returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The scans as the reply lists them: by day, each day's scans by time, newest first. */
function scansOf(reply: unknown, number: string): Scan[] {
  let history: Record<string, unknown>;
  try {
    history = replyFor(reply, number, 'history');
  } catch (error) {
    // The summary knew the item, so a history that does not is no answer either way.
    if (error instanceof NotFoundError) throw new IndeterminateError(PROVIDER, 'Kazpost did not return the history of an item it knows');
    throw error;
  }
  const days = history.events;
  if (!Array.isArray(days)) throw new SchemaError(PROVIDER, 'Kazpost returned a history without its scans');
  if (days.length > MAX_DAYS) throw new SchemaError(PROVIDER, 'Kazpost returned an oversized history');
  const scans: Scan[] = [];
  for (const day of days) {
    if (!isRecord(day) || !Array.isArray(day.activity)) throw new SchemaError(PROVIDER, 'Kazpost returned an invalid history day');
    for (const activity of day.activity) {
      if (scans.length >= MAX_ROWS) throw new SchemaError(PROVIDER, 'Kazpost returned an oversized history');
      if (!isRecord(activity) || !Array.isArray(activity.status)) throw new SchemaError(PROVIDER, 'Kazpost returned an invalid scan');
      // The page reads a scan's first code.
      const code = clean(activity.status[0], 60);
      if (!code) throw new SchemaError(PROVIDER, 'Kazpost returned a scan without its code');
      scans.push({ code, local: wallClock(day.date, activity.time), name: clean(activity.name, 160),
        address: clean(activity.city, 240), index: scans.length });
    }
  }
  return scans;
}

/**
 * The scans the page shows, oldest first. A correction cancels the latest
 * earlier scan of the code it corrects, then both are left out with the
 * other codes the page hides.
 */
function shownScans(scans: readonly Scan[]): Scan[] {
  // Oldest first; scans at the same second keep the order they were made in,
  // the reverse of the reply's.
  const ordered = [...scans].sort((left, right) => left.local < right.local ? -1
    : left.local > right.local ? 1 : right.index - left.index);
  const kept: Scan[] = [];
  for (const scan of ordered) {
    const undone = kazpostUndone(scan.code);
    if (!undone) {
      kept.push(scan);
      continue;
    }
    for (let at = kept.length - 1; at >= 0; at -= 1) {
      if (undone.includes(kept[at]!.code)) {
        kept.splice(at, 1);
        break;
      }
    }
  }
  return kept.filter(scan => !isHiddenKazpostCode(scan.code));
}

function eventOf(scan: Scan): CarrierEvent {
  const stage = kazpostStage(scan.code);
  const location = [scan.name, scan.address].filter(Boolean).join(', ');
  return {
    local_time: scan.local,
    ...(location ? { location } : {}),
    // A code the dictionary does not word shows as itself, for review.
    description: kazpostWording(scan.code) ?? scan.code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    provider_code: scan.code,
  };
}

/**
 * The tracker's two replies for one number: the item's summary, and its scans
 * grouped by day. A scan carries a code, which the page words from its
 * dictionary, and the office that made it. An item without a scan the page
 * shows answers with its summary's status alone.
 */
export function parseKazpost(summaryReply: unknown, historyReply: unknown, rawNumber: string): CarrierResult {
  const number = normalizeKazpostNumber(rawNumber);
  const summary = summaryOf(summaryReply, number);
  const details = {
    ...(summary.weight !== undefined ? { weight_kg: summary.weight } : {}),
    ...(summary.country ? { destination_country: summary.country } : {}),
  };

  const seen = new Set<string>();
  const shown = shownScans(scansOf(historyReply, number)).filter((scan) => {
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify([scan.code, scan.local, scan.name, scan.address]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).reverse();

  if (!shown.length) {
    if (!summary.code && !summary.status) throw new NoHistoryError(PROVIDER);
    const stage = summary.code ? kazpostStage(summary.code) : undefined;
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: summary.status || kazpostWording(summary.code) || summary.code,
      ...(summary.code ? { provider_code: summary.code } : {}),
      last_update: null,
      expected_delivery: null,
      ...details,
      summary_only: true,
      events: [],
    };
  }

  const events = shown.map(eventOf);
  const latest = events[0]!;
  // A code the map does not know has no stage; the newest scan with one sets the item's.
  const current = events.findIndex(event => event.stage);
  const stage = current >= 0 ? events[current]!.stage as Stage : undefined;
  // The office a ready scan waits at is the pickup point. A delivered item was
  // collected there when that scan was its last movement.
  const earlier = current >= 0 ? events.slice(current + 1) : [];
  const waiting = stage === 'ready_for_pickup' ? current
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? current + 1 + earlier.findIndex(event => event.stage === 'ready_for_pickup')
      : -1;
  const point = waiting >= 0 ? [shown[waiting]!.name, shown[waiting]!.address].filter(Boolean).join('\n') : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...details,
    ...(point ? { pickup_point: point } : {}),
    events,
  };
}
