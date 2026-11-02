import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizePackManNumber } from './number.js';
import { isPackManBilling, packManStage } from './status.js';

export const PROVIDER = 'Pack-Man';
// A long history is under 30 kB.
export const PACK_MAN_MAX_BYTES = 500_000;
// Every scan is in the Attica basin.
const ZONE = 'Europe/Athens';
// The clock a scan shows, "28/07/2026 · 15:47".
const SHOWN = /^\d{2}\/\d{2}\/\d{4} · \d{2}:\d{2}$/;
const SHOWN_FORMAT = "dd/MM/yyyy '·' HH:mm";
// The page's notices for a code it does not know and for one it cannot read.
const ABSENT = /^Δεν βρέθηκε αποστολή με αυτόν τον κωδικό/u;
const MALFORMED = /^Ο κωδικός δεν έχει σωστή μορφή/u;
// A firewall's or bot check's page in place of the search page.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied|Captcha)|imunify360|sgcaptcha/i;
const MAX_ROWS = 300;

/** Whether a page is a firewall's or bot check's instead of the search page. */
export function isPackManBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/**
 * A scan's clock. The page shows the Athens wall clock to the minute, and its
 * `datetime` adds the seconds and an offset. The attribute stands when it reads
 * the shown minute in Athens; otherwise the shown clock is read in Athens.
 */
function scanTime(time: Cheerio<Element>): string {
  const shown = clean(time.text(), 40);
  const wall = SHOWN.test(shown) ? zonedTime(shown, SHOWN_FORMAT, ZONE) : null;
  if (!wall) throw new SchemaError(PROVIDER, 'Pack-Man returned an invalid scan time');
  const stamped = explicitOffsetTime(time.attr('datetime'));
  if (stamped && DateTime.fromMillis(stamped.timestamp, { zone: ZONE }).toFormat(SHOWN_FORMAT) === shown) return stamped.iso;
  return wall.iso;
}

/**
 * The scans of the timeline, oldest first as the page draws them: each one's
 * wording and clock. The invoicing steps after the delivery are billing, not
 * the parcel's movement, and are left out. The remark under a scan is not read.
 */
function scansOf($: CheerioAPI, items: Cheerio<Element>): CarrierEvent[] {
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pack-Man returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const element of items.toArray()) {
    const item = $(element);
    const description = clean(item.find('.tl-status').first().text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'Pack-Man returned a scan without wording');
    const clock = item.find('.tl-time');
    const times = clock.find('time');
    if (clock.length > 1 || (clock.length && times.length !== 1)) throw new SchemaError(PROVIDER, 'Pack-Man returned an invalid scan time');
    const time = times.length ? scanTime(times) : undefined;
    if (isPackManBilling(description)) continue;
    const identity = JSON.stringify([time ?? null, description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stage = packManStage(description);
    events.push({ ...(time ? { time } : {}), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  return events;
}

/**
 * Pack-Man's search page for one voucher, rendered on the server: the voucher
 * over a timeline of every scan, oldest first. A code it does not know gets a
 * notice that does not name it.
 */
export function parsePackMan(html: string, raw: string): CarrierResult {
  const voucher = normalizePackManNumber(raw);
  const $ = load(html);
  if ($('form#trackForm').length !== 1) {
    if (isPackManBlockPage(html)) throw new ChallengeError(PROVIDER, 'Pack-Man answered with a block page');
    throw new SchemaError(PROVIDER, 'Pack-Man did not return its search page');
  }
  const answer = $('#result');
  if (answer.length !== 1) throw new SchemaError(PROVIDER, 'Pack-Man did not look the voucher up');
  const alert = answer.find('.alert');
  if (alert.length) {
    const notice = clean(alert.first().text(), 200);
    if (ABSENT.test(notice)) throw new NotFoundError(PROVIDER);
    if (MALFORMED.test(notice)) throw new InvalidInputError(PROVIDER, 'Pack-Man does not read the voucher as one of its codes', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Pack-Man did not complete the lookup');
  }
  const shipment = answer.find('.track-result');
  if (shipment.length !== 1) throw new SchemaError(PROVIDER, 'Pack-Man returned a page without the shipment');
  const printed = clean(shipment.find('.track-code').first().text(), 40).toUpperCase();
  if (!printed) throw new SchemaError(PROVIDER, 'Pack-Man returned a shipment without its voucher');
  if (printed !== voucher) throw new IndeterminateError(PROVIDER, 'Pack-Man answered for another shipment');
  const timeline = shipment.find('ol.timeline');
  if (timeline.length !== 1) throw new SchemaError(PROVIDER, 'Pack-Man returned a shipment without its timeline');
  // Newest first; the page draws the current scan last.
  const events = scansOf($, timeline.children('li')).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    events,
  };
}
