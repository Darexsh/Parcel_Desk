import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { fermopointStage } from './status.js';

export const PROVIDER = 'Fermopoint';
// The page is about 35 kB, most of it the site's header, footer and scripts.
export const FERMOPOINT_MAX_BYTES = 1_000_000;
const ZONE = 'Europe/Rome';
// `fermopoint-1`: a letter, four letters or digits, two letters and six digits.
// The page also takes digits alone, then calls the code invalid.
const NUMBER = /^[A-Z][A-Z0-9]{4}[A-Z]{2}\d{6}$/;
// The page's heading: a collection's Fermoticket or a shipment sent from a shop, then the code.
const HEADING = /^(?:Fermoticket|Spedizione) n\.\s*([A-Z0-9]+)$/i;
// The page's answer for a code it holds no booking for.
const INACTIVE = /non ci risulta essere attivo/i;
const CLOCK = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/;
const MAX_ROWS = 200;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|The request is blocked/i;

/** A Fermoticket or shipment code, in upper case as the page shows it; anything else is not one Fermopoint issues. */
export function normalizeFermopointNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fermopoint codes are a letter, four letters or digits, two letters and six digits');
  return number;
}

/** A step's clock, "26/02/2025 19:26:50", as a wall clock with no zone. */
function wallClock(value: string): string {
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const wall = CLOCK.test(value) ? DateTime.fromFormat(value, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' }) : null;
  if (!wall?.isValid) throw new SchemaError(PROVIDER, 'Fermopoint returned an invalid step time');
  return wall.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Fermopoint's wall clock in Italy, dated in Rome's zone. A wall time Rome
 * skips when its clocks go forward stays as it was written.
 */
function romeClock(local: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
  return instant.isValid && instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? { time: instant.toISO({ suppressMilliseconds: true }) } : { local_time: local };
}

/**
 * The booking page `/prenotazione/{code}` for one Fermoticket or shipment. It
 * heads the answer with the code, then lists the steps in a table, newest
 * first, after a copy of the current one that small screens show. The page
 * names neither the shop nor any BRT number to anyone not signed in. A code it
 * holds no booking for gets its "not active" notice under the same heading.
 */
export function parseFermopoint(html: string, rawNumber: string): CarrierResult {
  const number = normalizeFermopointNumber(rawNumber);
  const $ = load(html);
  const content = $('.body-content').first();
  const heading = clean(content.find('h1.page-title').first().text(), 80);
  if (!heading) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fermopoint answered with a block page');
    throw new SchemaError(PROVIDER, 'Fermopoint did not return its booking page');
  }
  const shown = HEADING.exec(heading)?.[1];
  if (!shown) throw new SchemaError(PROVIDER, 'Fermopoint returned a booking page without its code');
  if (shown.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Fermopoint answered for another code');

  const table = content.find('table.table');
  if (!table.length) {
    if (INACTIVE.test(content.text())) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Fermopoint returned a booking page without its steps');
  }
  if (INACTIVE.test(content.text())) throw new SchemaError(PROVIDER, 'Fermopoint returned steps with its not-active notice');
  const rows = table.find('tr').not('.visible-xs').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Fermopoint returned an oversized history');

  const seen = new Set<string>();
  const steps: { event: CarrierEvent; local: string }[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'Fermopoint returned a step it does not render');
    const local = wallClock(clean(cells.eq(0).text(), 32));
    const description = clean(cells.eq(1).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Fermopoint returned a step without wording');
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = fermopointStage(description);
    steps.push({ local, event: {
      ...romeClock(local),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!steps.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; steps of one second keep the page's order.
  const events = steps.map((step, index) => ({ ...step, index }))
    .sort((a, b) => b.local.localeCompare(a.local) || a.index - b.index).map((step) => step.event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    events,
  };
}
