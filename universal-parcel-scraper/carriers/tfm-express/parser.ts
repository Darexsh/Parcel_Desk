import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { tfmExpressStage } from './status.js';

export const PROVIDER = 'TFM Express';
// The page is about 15 kB without a shipment and 21 kB with a short history.
export const TFM_EXPRESS_MAX_BYTES = 512 * 1024;
// Dubai, where TFM Express is, at whose fixed offset the instants are returned.
const ZONE = 'Asia/Dubai';

const NUMBER = /^\d{12}$/;
// A row's day and clock as the page writes them, "03 June 2026 11:06 AM".
const CLOCK = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4}) (0?[1-9]|1[0-2]):([0-5]\d) ([AP]M)$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NOT_FOUND = /^Shipment Not Found$/i;
const ECHO = /^Tracking Number:\s*(\S+)$/i;
const COLUMNS = ['date', 'status', 'activity'];
// A run of nine or more digits, with spaces, brackets, dots or hyphens between
// them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|requested URL was rejected|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
const MAX_ROWS = 500;

/** A TFM Express airwaybill: twelve digits. Anything else is not a number TFM Express issues. */
export function normalizeTfmExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TFM Express airwaybills are twelve digits');
  return number;
}

function assertNotBlocked(html: string): void {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TFM Express answered with a browser check');
}

/** A row's clock, which the page gives in UTC when it is asked for offset 0, at Dubai's offset. */
function instant(text: string): { iso: string; timestamp: number } {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  if (!match || !month) throw new SchemaError(PROVIDER, 'TFM Express returned an invalid scan time');
  const hour = (Number(match[4]) % 12) + (match[6]!.toUpperCase() === 'PM' ? 12 : 0);
  const parsed = DateTime.fromObject({ year: Number(match[3]), month, day: Number(match[1]), hour, minute: Number(match[5]) },
    { zone: 'utc' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'TFM Express returned an invalid scan time');
  return { iso: parsed.setZone(ZONE).toISO({ suppressMilliseconds: true })!, timestamp: parsed.toMillis() };
}

/** A row's activity, without phone numbers. */
function activityOf(text: string): string {
  return clean(clean(text, 400).replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Row { event: CarrierEvent; timestamp: number }

function rowOf(cells: Cheerio<AnyNode>): Row {
  if (cells.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'TFM Express returned an invalid history row');
  const cell = (at: number, length: number) => clean(cells.eq(at).text(), length);
  const clock = instant(cell(0, 60));
  const status = cell(1, 80);
  if (!status) throw new SchemaError(PROVIDER, 'TFM Express returned a history row without its status');
  const activity = activityOf(cell(2, 400));
  const staged = tfmExpressStage(status, activity);
  return { timestamp: clock.timestamp, event: {
    time: clock.iso,
    description: activity || status,
    provider_code: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The page `POST /Skybill/TrackSkybill` answers for one airwaybill, under
 * the tracking form. A shipment gets a summary naming its tracking number
 * and the steps it reached, then its history newest first: each row a day
 * and a clock, a status name and an activity line, often empty. The clocks
 * are in the offset the form posts, here UTC. An airwaybill the tracker does
 * not know gets "Shipment Not Found". The summary must name the whole
 * airwaybill asked.
 */
export function parseTfmExpress(html: string, raw: string): CarrierResult {
  const number = normalizeTfmExpressNumber(raw);
  const $ = load(html);
  if ($('form#form[action="/Skybill/TrackSkybill"]').length !== 1) {
    assertNotBlocked(html);
    throw new SchemaError(PROVIDER, 'TFM Express returned an unexpected page');
  }
  const summaries = $('.shipmentbox-summary');
  if (!summaries.length) {
    const absent = $('#shipmentNotExists');
    if (absent.length === 1 && NOT_FOUND.test(clean(absent.text(), 80))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'TFM Express did not answer the lookup');
  }
  if (summaries.length !== 1) throw new SchemaError(PROVIDER, 'TFM Express returned an unexpected number of shipments');
  const echo = ECHO.exec(clean(summaries.children('p').first().text(), 80));
  if (!echo) throw new SchemaError(PROVIDER, 'TFM Express returned a shipment without its number');
  if (echo[1] !== number) throw new SchemaError(PROVIDER, 'TFM Express answered for a different airwaybill');

  const tables = $('.shipmentbox-history table');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'TFM Express returned a shipment without its history');
  const columns = tables.find('thead th').map((_, node) => clean($(node).text(), 40).toLowerCase()).get();
  if (JSON.stringify(columns) !== JSON.stringify(COLUMNS)) throw new SchemaError(PROVIDER, 'TFM Express changed its history table');
  const lines = tables.find('tbody > tr');
  if (lines.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TFM Express returned an oversized history');

  const seen = new Set<string>();
  const rows: Row[] = [];
  lines.each((_, node) => {
    const row = rowOf($(node).children('td'));
    const key = JSON.stringify([row.timestamp, row.event.provider_code, row.event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first, as the page lists them.
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  rows.sort((a, b) => b.timestamp - a.timestamp);
  const events = rows.map((row) => row.event);
  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: decider!.time! } : {}),
    events,
  };
}
