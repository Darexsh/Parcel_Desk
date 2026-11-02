import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xpoLtlEventStage, xpoLtlSummaryStatus } from './status.js';

export const PROVIDER = 'XPO';
/** Both pages carry the site's whole template, about 40 KB for a long history. */
export const XPO_LTL_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const POUNDS_TO_KG = 0.453_592_37;
// The firewall in front of XPO's hosts answers HTTP 200 with this sentence.
const REJECTED = 'The requested URL was rejected';
const STATUS_LINK = 'a[href*="ShipmentStatusDefinitions.jsp?statusCode="]';
const DAY = '(\\d{1,2})/(\\d{1,2})/(\\d{2})';
const CLOCK = '(\\d{1,2}):([0-5]\\d) ([AP]M)';
const ROW_TIME = new RegExp(`^${DAY} ${CLOCK}$`);
const LAST_UPDATE = new RegExp(`Last update as of ${CLOCK} on ${DAY}(?!\\d)`);
const ESTIMATE = new RegExp(`(?:^|\\s)Est Dlvr: ${DAY}(?!\\d)`);
const WEIGHT = /(?:^|\s)Wgt ([\d,]{1,9}) lbs(?:\s|$)/;
const NO_ESTIMATE: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
// Bookkeeping rows around the moves: someone looked the PRO up, the record
// was saved, or the system took the delivered shipment off its trailer.
const NOISE = new Set(['pro inquiry', 'record updated', 'system unload of final delivered pro']);

/** An XPO PRO number: nine digits, the last the remainder of the first eight divided by seven. */
export function normalizeXpoLtlNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError(PROVIDER, 'XPO PRO number is too long');
  const number = normalizeTrackingNumber(raw);
  if (/^\d{9}$/.test(number) && hasMod7CheckDigit(number)) return number;
  throw new InvalidInputError(PROVIDER, 'XPO PRO numbers are nine digits ending in a mod 7 check digit');
}

/** The eleven-digit form XPO's systems keep a PRO in, which its not-found notice names. */
export function xpoLtlElevenDigitPro(number: string): string {
  return `0${number.slice(0, 3)}0${number.slice(3)}`;
}

/** A page clock as a wall time, two-digit year in this century; the pages give no offset. */
function wallClock(month: string, day: string, year: string, hour: string, minute: string, meridiem: string): string | null {
  const h = Number(hour);
  if (h < 1 || h > 12) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: 2000 + Number(year), month: Number(month), day: Number(day),
    hour: (h % 12) + (meridiem === 'PM' ? 12 : 0), minute: Number(minute) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

function page(html: string): CheerioAPI {
  if (html.includes(REJECTED)) throw new ChallengeError(PROVIDER, 'XPO\'s firewall rejected the tracking request');
  // Line breaks part the shipment details ("Pcs 2<br>Wgt 370 lbs").
  const $ = load(html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<br\s*\/?>/gi, '\n'));
  $('script, style, noscript, template').remove();
  return $;
}

export interface XpoLtlSummary {
  code: string;
  label: string;
  lastUpdateLocal: string | null;
  expectedDelivery: string | null;
  weightKg: number | null;
}

/**
 * The PRO tracking page (`TrackingRS.jsp`): one status block whose label cell
 * names the PRO asked for, or the notice that names the PRO.
 * Only the status, the pickup and delivery days and the shipment details are
 * read; shipper, consignee, bill-to, references and documents never are.
 */
export function parseXpoLtlSummary(html: string, raw: string): XpoLtlSummary {
  const number = normalizeXpoLtlNumber(raw);
  const $ = page(html);
  const text = clean($.root().text(), html.length);
  if (!/\bPRO Tracking\b/.test(text)) throw new SchemaError(PROVIDER, 'XPO tracking page changed');
  const links = $(STATUS_LINK);
  if (!links.length) {
    const invalid = /The PRO (\S{1,64}) format is invalid\./.exec(text);
    if (invalid) {
      if (invalid[1] !== number) throw new SchemaError(PROVIDER, 'XPO rejected another PRO than the one asked for');
      throw new InvalidInputError(PROVIDER, 'XPO does not issue this PRO number', { reason: 'wrong_number' });
    }
    const absent = [...text.matchAll(/Shipment (\d{1,20}) is not currently available for tracking\./g)];
    if (absent.length === 1) {
      // The US system names the eleven-digit form, the Mexico system the PRO as asked.
      if (![xpoLtlElevenDigitPro(number), number].includes(absent[0]![1]!)) throw new SchemaError(PROVIDER, 'XPO answered for another PRO');
      throw new NotFoundError(PROVIDER);
    }
    throw new SchemaError(PROVIDER, 'XPO tracking page has no status for the PRO');
  }
  if (links.length !== 1) throw new SchemaError(PROVIDER, 'XPO tracking page shows several shipments');

  const labelCell = links.closest('td');
  if (clean(labelCell.text(), 64) !== `Status: PRO: ${number}`) {
    throw new SchemaError(PROVIDER, 'XPO tracking page does not identify the requested PRO');
  }
  const code = /[?&]statusCode=(\d{1,3})(?:&|$)/.exec(links.attr('href') ?? '')?.[1];
  const statusCell = labelCell.next('td');
  const label = clean(statusCell.find('b').first().text(), 120);
  if (!code || !label) throw new SchemaError(PROVIDER, 'XPO tracking page has no status');
  const update = LAST_UPDATE.exec(clean(statusCell.text(), 300));
  const lastUpdateLocal = update ? wallClock(update[4]!, update[5]!, update[6]!, update[1]!, update[2]!, update[3]!) : null;

  const fields = new Map<string, string>();
  // The status table's own rows; the shipment details hold a table of their own.
  const table = links.closest('table');
  for (const row of table.find('tr').filter((_, tr) => $(tr).closest('table').is(table)).toArray()) {
    const cells = $(row).children('td');
    const name = cells.length === 2 ? clean(cells.eq(0).text(), 64) : '';
    if (name === 'Pickup/Delivery' || name === 'Shipment Details') {
      if (fields.has(name)) throw new SchemaError(PROVIDER, 'XPO tracking page repeats a shipment field');
      fields.set(name, clean(cells.eq(1).text(), 300));
    }
  }
  const estimate = ESTIMATE.exec(fields.get('Pickup/Delivery') ?? '');
  const expectedDelivery = estimate ? calendarDay(2000 + Number(estimate[3]), Number(estimate[1]), Number(estimate[2])) : null;
  const pounds = WEIGHT.exec(fields.get('Shipment Details') ?? '')?.[1];
  const weight = pounds && /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(pounds) ? Number(pounds.replaceAll(',', '')) : null;
  return { code, label, lastUpdateLocal, expectedDelivery,
    weightKg: weight !== null && weight > 0 ? Math.round(weight * POUNDS_TO_KG * 1000) / 1000 : null };
}

interface Scan { localTime: string; location: string; description: string }

/**
 * The shipment history page (`ShipmentHistory.jsp`), oldest row first, under
 * a heading naming the PRO asked for. Null when the page says the history is
 * not available.
 */
export function parseXpoLtlHistory(html: string, raw: string): Scan[] | null {
  const number = normalizeXpoLtlNumber(raw);
  const $ = page(html);
  const headings = $('b').filter((_, bold) => /^PRO Number:/.test(clean($(bold).text(), 64)));
  if (headings.length !== 1 || clean(headings.text(), 64) !== `PRO Number: ${number}`) {
    throw new SchemaError(PROVIDER, 'XPO history does not identify the requested PRO');
  }
  const headers = $('tr').filter((_, row) => $(row).children('td').map((__, cell) => clean($(cell).text(), 32)).get()
    .join('|') === 'Date|Service Center|Description');
  if (!headers.length) {
    if ($('td').filter((_, cell) => clean($(cell).text(), 32) === 'Not available').length === 1) return null;
    throw new SchemaError(PROVIDER, 'XPO history page changed');
  }
  if (headers.length !== 1) throw new SchemaError(PROVIDER, 'XPO history page shows several histories');
  const header = headers.first();
  const table = header.closest('table');
  const rows = table.find('tr').filter((_, tr) => $(tr).closest('table').is(table)).toArray();
  const start = rows.indexOf(header.get(0)!);
  if (rows.length - start > MAX_ROWS) throw new SchemaError(PROVIDER, 'XPO returned too many history rows');
  const scans: Scan[] = [];
  for (const row of rows.slice(start + 1)) {
    const cells = $(row).children('td');
    // The notes under the rows span the table.
    if (cells.length !== 3) continue;
    const time = ROW_TIME.exec(clean(cells.eq(0).text(), 32));
    const localTime = time ? wallClock(time[1]!, time[2]!, time[3]!, time[4]!, time[5]!, time[6]!) : null;
    // The delivery route after the description names the driver's run.
    const description = clean(cells.eq(2).text(), 200).replace(/\s+-\s+P&D route:.*$/i, '');
    if (!localTime || !description) throw new SchemaError(PROVIDER, 'XPO history row has no valid time or description');
    if (NOISE.has(description.toLowerCase())) continue;
    scans.push({ localTime, location: clean(cells.eq(1).text(), 100), description });
  }
  return scans;
}

/**
 * The tracking result from the summary and, when it was read, the history.
 * The summary's code gives the current stage; a code that says nothing about
 * the freight leaves it to the rows.
 */
export function xpoLtlResult(summary: XpoLtlSummary, scans: Scan[] | null): CarrierResult {
  const seen = new Set<string>();
  const unique = (scans ?? []).filter((scan) => {
    const key = JSON.stringify([scan.localTime, scan.location, scan.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Rows come oldest first; rows of one minute keep the page's order.
  const events = unique.reverse().map((scan): CarrierEvent => {
    const stage = xpoLtlEventStage(scan.description);
    return { local_time: scan.localTime, ...(scan.location ? { location: scan.location } : {}), description: scan.description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  // Without a stage from the code, a final delivery decides, since the arrival
  // at the customer can be stamped after it; otherwise the newest staged row.
  const fallback = events.some((event) => event.stage === 'delivered') ? 'delivered'
    : events.find((event) => event.stage)?.stage as Stage | undefined;
  const stage = xpoLtlSummaryStatus(summary.code)?.stage ?? fallback;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: summary.label,
    provider_code: summary.code,
    last_update: null,
    last_update_local: summary.lastUpdateLocal ?? events[0]?.local_time ?? null,
    expected_delivery: stage && NO_ESTIMATE.has(stage) ? null : summary.expectedDelivery,
    ...(summary.weightKg !== null ? { weight_kg: summary.weightKg } : {}),
    ...(scans === null ? { summary_only: true } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
