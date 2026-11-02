import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tGroupStage } from './status.js';

export const PROVIDER = 'Tgroup';
// The page is about 30 kB, most of it the tracker's styles and script list.
export const T_GROUP_MAX_BYTES = 1_000_000;
const ZONE = 'Europe/Rome';
// `t-group-1`: Tgroup's `3010` and `TGR`, then fourteen digits.
const NUMBER = /^3010TGR\d{14}$/;
// "28/07/2026 09:43"
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// "1,50 Kg"
const WEIGHT = /^(\d{1,6}(?:,\d{1,3})?) ?Kg$/i;
// A scan's branch: its code, then its town, "901 - BORGO ESEMPIO".
const BRANCH = /^[A-Z0-9]{1,6} - (.+)$/;
// The tracker's answer for a number it holds no shipment for.
const NOT_FOUND = /NUMERO SPEDIZIONE NON TROVATO/i;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|_Incapsula_Resource/i;
const MAX_ROWS = 200;

/** A Tgroup shipment number; anything else is not one Tgroup's tracker opens. */
export function normalizeTGroupNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Tgroup shipment numbers are 3010TGR and fourteen digits');
  return number;
}

/**
 * A scan's clock, Tgroup's wall clock to the minute with no zone. Tgroup
 * works in Italy only, so it is dated in Rome's zone; the hour the clocks
 * repeat reads as its first occurrence, and a wall time Rome skips stays as
 * it was written.
 */
function scanClock(text: string): { local: string; clock: { time: string } | { local_time: string } } {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) throw new SchemaError(PROVIDER, 'Tgroup returned an invalid scan time');
  const local = `${day}T${match[4]}:${match[5]}:00`;
  const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
  return { local, clock: instant.isValid && instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? { time: instant.toISO({ suppressMilliseconds: true }) } : { local_time: local } };
}

/** The `LABEL: value` lines of the details box under this heading, by label. */
function details($: CheerioAPI, pane: Cheerio<Element>, heading: string): Map<string, string> {
  const fields = new Map<string, string>();
  const box = pane.find('.box').filter((_, node) => clean($(node).find('.box-title').first().text(), 80) === heading);
  if (box.length !== 1) throw new SchemaError(PROVIDER, `Tgroup returned a shipment without its ${heading} box`);
  for (const line of (box.find('.box-body').first().html() ?? '').split(/<br\s*\/?>/i)) {
    // The address lines carry no label and are never read.
    const field = /^([^:]{1,40}):\s*(.*)$/.exec(clean(load(line, null, false).root().text(), 200));
    if (field) fields.set(field[1]!.trim().toUpperCase(), field[2]!.trim());
  }
  return fields;
}

/** The weight the goods box gives, in kilograms, when it gives one. */
function weightKg(text: string | undefined): number | null {
  const match = WEIGHT.exec(text ?? '');
  const kg = match ? Number(match[1]!.replace(',', '.')) : 0;
  return kg > 0 ? kg : null;
}

/** The planned delivery day, "03/08/2026", as a calendar day. */
function plannedDay(text: string | undefined): string | null {
  const match = DAY.exec(text ?? '');
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/**
 * Tgroup's tracker page for one number, `/ttnet/traccia_spedizione/{number}`,
 * which the tracker renders on its server. Its first tab lists the scans,
 * oldest first, each with its wording, its clock and the branch that made it;
 * its second shows the shipment's details: the branch's own shipment number,
 * the delivery note, the goods, the sender's and recipient's postcode and
 * town and the planned delivery day. The page does not repeat the number
 * asked. A number it holds nothing for gets a notice instead of the tabs.
 */
export function parseTGroup(html: string, rawNumber: string): CarrierResult {
  normalizeTGroupNumber(rawNumber);
  const $ = load(html);
  const content = $('#bodyContent');
  if (!content.length) {
    if (NOT_FOUND.test(clean($('center').text(), 200))) throw new NotFoundError(PROVIDER);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Tgroup answered with a bot check');
    throw new SchemaError(PROVIDER, 'Tgroup did not return its tracker page');
  }
  if (NOT_FOUND.test(content.text())) throw new SchemaError(PROVIDER, 'Tgroup returned a shipment with its not-found notice');
  // One number opens one shipment; a page with several cannot say which is the number's.
  if (content.length !== 1 || content.find('#tab_1').length > 1 || content.find('#tab_2').length > 1) {
    throw new IndeterminateError(PROVIDER, 'Tgroup answered for several shipments');
  }
  const timeline = content.find('#tab_1 > ul.timeline');
  const pane = content.find('#tab_2');
  if (timeline.length !== 1 || pane.length !== 1) throw new SchemaError(PROVIDER, 'Tgroup returned a page without its tabs');
  // The shipment box must be there, though nothing in it is kept.
  details($, pane, 'Dettaglio Spedizione');
  const goods = details($, pane, 'Dettaglio Merce');
  const recipient = details($, pane, 'Destinatario');

  const rows = timeline.children('li').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Tgroup returned an oversized history');
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    const heading = $(row).find('.timeline-heading');
    if (heading.length !== 1) throw new SchemaError(PROVIDER, 'Tgroup returned a scan it does not render');
    const description = clean(heading.children('strong.timeline-header').text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Tgroup returned a scan without wording');
    const { local, clock } = scanClock(clean(heading.children('p').text(), 40));
    // The branch is the heading's own text after the clock; the delivery round's scan has none.
    const branch = clean(heading.clone().children().remove().end().text(), 120);
    const location = BRANCH.exec(branch)?.[1] ?? branch;
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tGroupStage(description);
    scans.push({ local, index, event: {
      ...clock, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans of one minute keep the page's order, the later one newer.
  const events = scans.sort((a, b) => b.local.localeCompare(a.local) || b.index - a.index).map((scan) => scan.event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const final = stage === 'delivered' || stage === 'returned';
  const deliveredAt = stage === 'delivered' ? current!.time : undefined;
  const weight = weightKg(goods.get('PESO'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    // The planned day stays on the page after the delivery.
    expected_delivery: final ? null : plannedDay(recipient.get('DATA SCARICO PREVISTA')),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}
