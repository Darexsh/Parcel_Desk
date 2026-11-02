import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { speedexStage } from './status.js';

export const PROVIDER = 'Speedex';
// A long history is under 50 kB.
export const SPEEDEX_MAX_BYTES = 1_000_000;
// Twelve-digit vouchers, and the DHL numbers of the parcels DHL hands to Speedex in Greece.
const NUMBER = /^(?:\d{12}|JJD\d{18})$/;
const STAMP = /^(\d{2})\/(\d{2})\/(\d{4}) στις (\d{2}):(\d{2})$/;
const NOT_FOUND = 'Δεν βρέθηκαν αποτελέσματα';
// The delivery card names whoever took the parcel after its wording.
const RECIPIENT = /\s*ΠΑΡΑΛΗΠΤΗΣ\s*:[\s\S]*$/u;
// A firewall or bot check's page in place of the tracker, which can come with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|_Incapsula_Resource|requested URL was rejected|captcha/i;
const MAX_ROWS = 300;

/** A Speedex voucher or a DHL number its tracker follows, in capitals; anything else is not one it tracks. */
export function normalizeSpeedexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Speedex vouchers are twelve digits');
  return number;
}

/** Whether a page is a firewall's or bot check's instead of the tracker's. */
export function isSpeedexBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/**
 * A scan's clock, "dd/mm/yyyy στις HH:mm": the branch's wall clock to the
 * minute, with no zone, so it stays local.
 */
function wallClock(text: string): string {
  const match = STAMP.exec(text);
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Speedex returned an invalid scan time');
  }
  return local;
}

/**
 * The place a scan names: a branch's street address, a comma and the branch,
 * or the comma and the branch alone. Only the branch is kept, usually its town.
 */
function branch(text: string): string {
  const comma = text.lastIndexOf(',');
  const name = clean(comma === -1 ? (/\d/.test(text) ? '' : text) : text.slice(comma + 1), 120);
  return /\p{L}/u.test(name) ? name : '';
}

interface Scan {
  readonly index: number;
  readonly event: CarrierEvent;
}

/**
 * One card: its wording, then lines for the clock, the place and the branch's
 * phone, and a map link for a branch. The phone and the map are not read; nor
 * is the delivery card's line naming who took the parcel.
 */
function card($: CheerioAPI, node: Cheerio<Element>, index: number): Scan {
  const title = node.find('h4.card-title').first();
  if (!title.length) throw new SchemaError(PROVIDER, 'Speedex returned a scan without wording');
  const lead = title.children('p').first();
  const description = clean((lead.length ? lead.text() : title.text()).replace(RECIPIENT, ''), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Speedex returned a scan without wording');
  const lines = node.find('p.card-subtitle span.font-small-3').toArray().map((line) => clean($(line).text(), 300));
  const local = wallClock(lines[0] ?? '');
  const location = branch(lines[1] ?? '');
  const stage = speedexStage(description);
  return { index, event: {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * The tracker page for one number. It echoes the number in its search field,
 * lists the scans oldest first and, for a delivered parcel, adds a delivery
 * card under them. A number it does not know gets its "no results" notice.
 */
export function parseSpeedex(html: string, raw: string): CarrierResult {
  const number = normalizeSpeedexNumber(raw);
  const $ = load(html);
  const section = $('section#timeline');
  if (section.length !== 1) {
    if (isSpeedexBlockPage(html)) throw new ChallengeError(PROVIDER, 'Speedex answered with a block page');
    throw new SchemaError(PROVIDER, 'Speedex did not return its tracking page');
  }
  const field = section.find('input#TxtConsignmentNumber');
  if (field.length !== 1) throw new SchemaError(PROVIDER, 'Speedex did not return its tracking page');
  const echoed = clean(field.attr('value'), 64);
  if (normalizeTrackingNumber(echoed) !== number) throw new IndeterminateError(PROVIDER, 'Speedex answered for another number');

  const rows = section.find('li.timeline-item').toArray();
  const delivery = section.find('.timeline-card.delivered-speedex').toArray();
  const notice = clean(section.find('.alert').text(), 200);
  if (!rows.length && !delivery.length) {
    if (notice.startsWith(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    if (notice) throw new IndeterminateError(PROVIDER, 'Speedex did not complete the lookup');
    if (section.find('ul.timeline').length) throw new NoHistoryError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Speedex returned a tracking page without scans');
  }
  if (rows.length + delivery.length > MAX_ROWS || delivery.length > 1) throw new SchemaError(PROVIDER, 'Speedex returned an invalid history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const [index, node] of [...rows, ...delivery].entries()) {
    const scan = card($, $(node), index);
    const identity = JSON.stringify([scan.event.local_time, scan.event.description, scan.event.location ?? '']);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  // Newest first; scans of the same minute keep the page's order, reversed.
  const events = scans.sort((left, right) => (right.event.local_time as string).localeCompare(left.event.local_time as string)
    || right.index - left.index).map((scan) => scan.event);

  const newest = events[0]!;
  // The delivery card settles a delivery; otherwise the newest scan with a stage.
  const stage = (delivery.length ? 'delivered' : events.find((event) => event.stage)?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
