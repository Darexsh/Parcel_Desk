import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { icsCourierStage } from './status.js';

export const PROVIDER = 'ICS Courier';
// A page is about 80 kB, and up to twice that when it carries a signature image.
export const ICS_COURIER_MAX_BYTES = 1024 * 1024;

// The ASP.NET page's prefix for the tracker's controls.
const ID = 'ctl00_ctl00_ContentPlaceHolderDefault_TrackingMain_2_';
const MAX_ROWS = 300;
// `ND` (next day) or `GR` (ground), twelve letters and digits, then the
// destination's postal code without its space.
const NUMBER = /^(?:ND|GR)[0-9A-Z]{12}[A-Z]\d[A-Z]\d[A-Z]\d$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The summary's answer for a number the tracker does not have.
const NOT_FOUND = 'not found';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|_Incapsula_Resource|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// "At ICS Branch ETOBICOKE , ON for processing": the branch's town and province.
const BRANCH = /^At ICS Branch (\S.*?)\s*,\s*([A-Z]{2}) for processing$/i;
const ATTEMPT = /^Delivery Attempt\s*:\s*(.*)$/i;
// Openings after which the tracker names the recipient, the shipper or the
// pickup point and its address: only the opening is kept.
const OPENINGS = [/^Delivered\b/i, /^Picked Up\b/i, /^At SMARTSpot for pickup\b/i];
const FINAL = new Set<Stage>(['delivered', 'returned']);

/** A whole ICS Courier tracking number in upper case; anything else is not one ICS issues. */
export function normalizeIcsCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'ICS Courier numbers are ND or GR, twelve letters and digits, then a postal code');
  }
  return number;
}

/** "2026-10-01 07:03:54" as a wall clock. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'ICS Courier returned an invalid scan time');
  }
  return local;
}

function visible(element: Cheerio<Element>): boolean {
  return !/display\s*:\s*none/i.test(element.attr('style') ?? '');
}

/** A row's wording without the person or address some rows go on to name, and the branch it was scanned at. */
function wording(text: string): { description: string; location?: string } {
  const branch = BRANCH.exec(text);
  if (branch) {
    const location = `${clean(branch[1], 80)}, ${branch[2]!.toUpperCase()}`;
    return { description: `At ICS Branch ${location} for processing`, location };
  }
  for (const opening of OPENINGS) {
    const match = opening.exec(text);
    if (match) return { description: match[0] };
  }
  // The driver's reason is kept unless it looks like an address.
  const attempt = ATTEMPT.exec(text);
  if (attempt) return { description: attempt[1] && !/\d/.test(attempt[1]) ? `Delivery Attempt: ${attempt[1]}` : 'Delivery Attempt' };
  return { description: text };
}

/**
 * The SMARTSpot the page names for collection: its name, then its address
 * lines. The panel's hours and coordinates are not kept.
 */
function pickupPoint($: CheerioAPI): string {
  const panel = $(`#${ID}pnlSmartSport`);
  if (panel.length !== 1 || !visible(panel)) return '';
  const sections: Record<'name' | 'address', string[]> = { name: [], address: [] };
  let section: keyof typeof sections | null = null;
  let line = '';
  const flush = () => {
    const text = clean(line, 120);
    if (section && text) sections[section].push(text);
    line = '';
  };
  panel.find('#linkbranch').contents().each((_, node) => {
    if (node.nodeType === 3) {
      line += $(node).text();
      return;
    }
    if (node.nodeType !== 1) return;
    flush();
    // The labels open each part, and the hours' heading ends them.
    const element = $(node);
    if (element.is(`#${ID}lblName`)) section = 'name';
    else if (element.is(`#${ID}lblAddress`)) section = 'address';
    else if (!element.is('br')) section = null;
  });
  flush();
  if (sections.name.length !== 1 || !sections.address.length || sections.address.length > 6) return '';
  return [...sections.name, ...sections.address].join('\n');
}

/** The page without a result table: a block page, the tracker's own notice, or a changed page. */
function noResult($: CheerioAPI, html: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ICS Courier answered with a block page');
  const notice = clean($(`#${ID}lblError`).text(), 200);
  if ($(`#${ID}txtPin`).length && notice) throw new IndeterminateError(PROVIDER, 'ICS Courier answered with a notice');
  throw new SchemaError(PROVIDER, 'ICS Courier did not return its result table');
}

/**
 * ICS Courier's tracking page for one number: a summary row per number asked
 * (its number, last update, status, signatory and estimated delivery day),
 * then the first parcel's history, each row a wall clock and a wording. A
 * number the tracker does not have gets a summary row saying "Not Found" and
 * no history. The summary and the history must both name the number asked.
 * The signatory, the signature image, the recipient and shipper details some
 * rows carry, and the pickup point's hours and coordinates are not read.
 */
export function parseIcsCourier(html: string, raw: string): CarrierResult {
  const number = normalizeIcsCourierNumber(raw);
  const $ = load(html);
  const summary = $(`table#${ID}gvresult`);
  if (!summary.length) noResult($, html);
  const rows = summary.find('tr').filter((_, row) => $(row).children('td').length > 0);
  if (summary.length !== 1 || rows.length !== 1) throw new SchemaError(PROVIDER, 'ICS Courier returned an unexpected summary');
  const cells = rows.first().children('td');
  if (cells.length !== 5) throw new SchemaError(PROVIDER, 'ICS Courier summary layout changed');
  const text = (index: number, maxLength = 300) => clean(cells.eq(index).text(), maxLength);
  if (returnedTrackingNumber(text(0, 4096)) !== number) throw new IndeterminateError(PROVIDER, 'ICS Courier answered for another number');

  const history = $(`table#${ID}gvTracingDetail`);
  if (text(2).toLowerCase() === NOT_FOUND) {
    if (history.length) throw new SchemaError(PROVIDER, 'ICS Courier returned a history for a number it did not find');
    throw new NotFoundError(PROVIDER);
  }
  if (history.length !== 1 || !visible($(`#${ID}pnlPinTrackingDetail`))) {
    throw new SchemaError(PROVIDER, 'ICS Courier returned a parcel without its history');
  }
  if (returnedTrackingNumber(clean($(`#${ID}lblPinNumber`).text(), 4096)) !== number) {
    throw new IndeterminateError(PROVIDER, 'ICS Courier returned the history of another number');
  }

  const scans = history.find('tr').filter((_, row) => $(row).children('td').length > 0).toArray();
  if (scans.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ICS Courier returned too many rows');
  const seen = new Set<string>();
  const events: { event: CarrierEvent; local: string; index: number }[] = [];
  for (const [index, row] of scans.entries()) {
    const columns = $(row).children('td');
    if (columns.length !== 2) throw new SchemaError(PROVIDER, 'ICS Courier history layout changed');
    const local = wallClock(clean(columns.eq(0).text(), 32));
    const raw = clean(columns.eq(1).text(), 300);
    if (!raw) throw new SchemaError(PROVIDER, 'ICS Courier returned a row without wording');
    const { description, location } = wording(raw);
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = icsCourierStage(description);
    events.push({ index, local, event: {
      local_time: local, description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The page lists rows in the order they were recorded, and a
  // sorter's scans can be recorded hours after their clock; equal clocks keep
  // the page's order.
  events.sort((left, right) => left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index);
  const newestFirst = events.map(({ event }) => event);

  const newest = events[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The estimated day is the parcel's while it is on its way, and stale once a later day's scan is in.
  const estimate = text(4, 16);
  const eta = DAY.test(estimate) && DateTime.fromISO(estimate, { zone: 'UTC' }).isValid
    && !(stage && FINAL.has(stage)) && estimate >= newest.local.slice(0, 10) ? estimate : null;
  const point = newestFirst.some((event) => event.stage === 'ready_for_pickup') ? pickupPoint($) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.event.description!,
    last_update: null,
    last_update_local: newest.local,
    expected_delivery: eta,
    ...(point ? { pickup_point: point } : {}),
    events: newestFirst,
  };
}
