import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { loomisEstimate, loomisStage } from './status.js';

export const PROVIDER = 'Loomis Express';
// The page is about 70 kB of site around a few kilobytes per waybill.
export const LOOMIS_MAX_BYTES = 1_000_000;

// A Loomis Express waybill: NET or LSHP and eight digits.
const NUMBER = /^(?:NET|LSHP)\d{8}$/;
const HEADING = 'Tracking Results';
const FOUND = 'Found below waybills:';
const MISSING = 'Below waybills are not available at this moment:';
const COLUMNS = 'DATE/TIME|STATUS|CITY';
// "SHIPMENT # : X PIECE # : X", once the reference lines are left out.
const IDENTITY = /^SHIPMENT # : (\S+) PIECE # : (\S+)$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Web Page Blocked|Request Rejected|Access Denied|Attention Required|Just a moment)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Stages after which an estimate no longer applies.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'ready_for_pickup']);

type Selection = ReturnType<CheerioAPI>;

/** A Loomis Express waybill as its tracker takes it: NET or LSHP and eight digits. */
export function normalizeLoomisNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError(PROVIDER, 'Loomis Express waybill is too long');
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Loomis Express tracks waybills of NET or LSHP and eight digits');
  return number;
}

/**
 * A row's clock ("2026-03-09 13:40:18") as a wall time; the page gives no
 * offset. A clock at midnight exactly is a calendar day: the shipment record
 * and the estimate carry the day alone.
 */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (hour > 23) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: 'UTC' });
  if (!parsed.isValid) return null;
  return hour === 0 && minute === 0 && second === 0 ? parsed.toFormat('yyyy-MM-dd') : parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The heading of a list of waybills and the waybills it names. */
function listOf($: CheerioAPI, box: Selection): { label: string; numbers: string[] } {
  const rows = box.find('.row');
  const label = clean(rows.first().text(), 80);
  const numbers = box.find('.col-md-3').toArray().map(cell => clean($(cell).text(), 80).toUpperCase());
  return { label, numbers };
}

/** The shipment and piece numbers a waybill's block names. Its reference lines are never read. */
function identityOf(block: Selection): { shipment: string; piece: string } | null {
  const headers = block.find('.col-md-10 > div');
  if (headers.length !== 1) return null;
  const header = headers.first().clone();
  header.children('div').remove();
  const match = IDENTITY.exec(clean(header.text(), 200));
  return match ? { shipment: match[1]!.toUpperCase(), piece: match[2]!.toUpperCase() } : null;
}

/**
 * Loomis Express's tracking results for one waybill. The page lists the
 * waybills it found, then a block for each with its scans newest first, or
 * lists the waybill as not available. The block must carry the requested
 * waybill as its anchor, shipment and piece number. Reference lines, the
 * proof-of-delivery form and the progress bar are never read.
 */
export function parseLoomis(html: string, raw: string): CarrierResult {
  const number = normalizeLoomisNumber(raw);
  const $ = load(html);
  $('script, style, noscript, template, svg').remove();
  const headings = $('h2.block-title').filter((_, heading) => clean($(heading).text(), 80) === HEADING);
  if (headings.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Loomis Express answered with a block page');
    throw new SchemaError(PROVIDER, 'Loomis Express did not return its tracking results');
  }
  const results = headings.first().closest('section');
  const boxes = results.find('.div_bg_blue_1').toArray().map(box => $(box));
  const blocks = boxes.filter(box => box.children('a[name]').length > 0);
  const lists = boxes.filter(box => box.children('a[name]').length === 0).map(box => listOf($, box));
  const found = lists.filter(list => list.label === FOUND);
  const missing = lists.filter(list => list.label === MISSING);
  if (found.length + missing.length !== lists.length || found.length > 1 || missing.length > 1) {
    throw new SchemaError(PROVIDER, 'Loomis Express results page changed');
  }
  const own = blocks.filter(block => clean(block.children('a[name]').first().attr('name'), 80).toUpperCase() === number);
  const listed = found[0]?.numbers.includes(number) ?? false;
  if (missing[0]?.numbers.includes(number)) {
    if (listed || own.length || missing[0].numbers.length !== 1) {
      throw new SchemaError(PROVIDER, 'Loomis Express both found and missed the waybill');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (!listed || own.length !== 1) throw new SchemaError(PROVIDER, 'Loomis Express did not answer for the requested waybill');
  const block = own[0]!;
  const identity = identityOf(block);
  if (!identity || identity.shipment !== number || identity.piece !== number) {
    throw new SchemaError(PROVIDER, 'Loomis Express answered for a different waybill');
  }

  const grid = block.find('.track-grid');
  const columns = grid.find('.tracking-header').first().children('div').map((_, cell) => clean($(cell).text(), 32)).get().join('|');
  if (grid.length !== 1 || columns !== COLUMNS) throw new SchemaError(PROVIDER, 'Loomis Express history columns changed');
  const rows = grid.find('.tracking-detail').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Loomis Express returned too many scans');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let estimate: string | null = null;
  for (const node of rows) {
    const cells = $(node).children('div');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Loomis Express history row changed');
    const local = wallClock(clean(cells.eq(0).text(), 32));
    const description = clean(cells.eq(1).text(), 300);
    if (!local || !description) throw new SchemaError(PROVIDER, 'Loomis Express returned a scan without a clock or wording');
    if (loomisEstimate(description)) {
      estimate ??= local.slice(0, 10);
      continue;
    }
    const location = clean(cells.eq(2).text(), 100);
    const event: CarrierEvent = { local_time: local, description, ...(location ? { location } : {}) };
    // A scan listed twice is one scan.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stage = loomisStage(description);
    if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Loomis Express lists the waybill without scans');

  // The page's order: newest first, across facilities in different zones,
  // with the shipment record's day at the end.
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const newestDay = String(newest.local_time).slice(0, 10);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    // Kept while the parcel is on its way, and dropped once a later day's scan arrives.
    expected_delivery: estimate && !(stage && SETTLED.has(stage)) && estimate >= newestDay ? estimate : null,
    events: events.slice(0, MAX_EVENTS),
  };
}
