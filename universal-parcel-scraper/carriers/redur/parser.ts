import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { redurStage } from './status.js';

export const PROVIDER = 'Redur';
// A page is about 120 kB, most of it the site's own markup.
export const REDUR_MAX_BYTES = 2 * 1024 * 1024;

const NUMBER = /^\d{14}$/;
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) ((?:[01]\d|2[0-3]):[0-5]\d)$/;
// The rail's last step; the page marks the current one active.
const DELIVERED_STEP = '#track-trace-7';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Redur tracking number: fourteen digits. */
export function normalizeRedurNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Redur tracking numbers are fourteen digits');
  return number;
}

/**
 * A bot check or firewall page in place of the tracker. Every page loads
 * Cloudflare Turnstile for its contact form, so that alone is no check.
 */
export function isRedurChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|challenge-platform/i.test(html);
}

/** A scan's wall clock, to the minute and without a zone. Midnight marks a scan dated to the day alone. */
function scanClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Redur returned an invalid scan time');
  return match[4] === '00:00' ? day : `${day}T${match[4]}:00`;
}

/**
 * The tracker's answer page for one number: the number asked, a progress
 * rail, and the scans oldest first, each with its wording, a wall clock, the
 * depot and the number of packages it covers. A number the tracker does not
 * know gets the same page marked as an error, with an empty rail and no scans.
 */
export function parseRedur(html: string, raw: string): CarrierResult {
  const number = normalizeRedurNumber(raw);
  const $ = load(html);
  const result = $('#result-track-trace');
  if (result.length !== 1) {
    if (isRedurChallenge(html)) throw new ChallengeError(PROVIDER, 'Redur answered with a browser check');
    // The search form comes back marked as an error when the tracker refuses the request's fields.
    throw new SchemaError(PROVIDER, 'Redur returned a page without a tracking answer');
  }
  // The page shows the number twice, for wide and narrow screens.
  const shown = result.find('[id="envio-id"]').toArray().map(node => clean($(node).text(), 64));
  if (!shown.length || shown.some(value => !/^[A-Za-z0-9]{1,40}$/.test(value))) {
    throw new SchemaError(PROVIDER, 'Redur returned an answer without the number asked');
  }
  if (shown.some(value => value !== number)) throw new IndeterminateError(PROVIDER, 'Redur answered for another shipment');

  const summary = result.find('.result-states');
  const table = result.find('.seguimiento-table');
  if (summary.length !== 1 || table.length !== 1) throw new SchemaError(PROVIDER, 'Redur changed its tracking answer');
  const marks = (summary.attr('class') ?? '').split(/\s+/);
  const rows = table.children('.table_state');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Redur returned an oversized history');
  if (marks.includes('error')) {
    if (rows.length) throw new SchemaError(PROVIDER, 'Redur marked a history as an error');
    throw new NotFoundError(PROVIDER);
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('div');
    if (cells.length !== 4 || !cells.eq(0).hasClass('title')) throw new SchemaError(PROVIDER, 'Redur history rows changed');
    const description = clean(cells.eq(0).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Redur returned a scan without wording');
    const local = scanClock(clean(cells.eq(1).text(), 32));
    // The depot; the fourth cell counts the packages the scan covers.
    const location = clean(cells.eq(2).text(), 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = redurStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans of the same minute keep the page's order, reversed.
  events.reverse().sort((a, b) => (a.local_time! < b.local_time! ? 1 : a.local_time! > b.local_time! ? -1 : 0));

  const decider = events.find(event => event.stage);
  let stage = decider?.stage as Stage | undefined;
  let source = decider?.stage_source;
  let text = (decider ?? events[0]!).description!;
  // A delivered rail holds for the shipment, whatever a later scan says. The
  // page fades the rail out for shipments it marks with a numbered error.
  const faded = marks.some(mark => /^error-\d+$/.test(mark));
  const delivered = result.find(DELIVERED_STEP);
  if (!faded && delivered.hasClass('active') && stage !== 'delivered') {
    stage = 'delivered';
    source = 'carrier_map';
    text = clean(delivered.children('p').text(), 80) || 'Entregado';
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: text,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
