import { load } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correStage } from './status.js';

export const PROVIDER = 'CORRE';
// An item's page is under a kilobyte.
export const CORRE_MAX_BYTES = 256 * 1024;

const MAX_RECORDS = 200;
const MAX_FIELDS = 20;
const TITLE = 'Track & Trace de objetos CORRE';
// The line every search that ran ends with: how long it took.
const SEARCHED = /\bA pesquisa demorou \d+ milisegundos\b/;
// The lookup's answer to a code that is not thirteen characters long.
const WRONG_LENGTH = /\bO numero de objecto tem que ter 13 caracteres\b/;
// A firewall's, CDN's or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|captcha/i;
// A record's DATA, "202603110914": the year, month, day, hour and minute.
const CLOCK = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * CORRE's national lookup finds the items CORRE itself registered, under
 * S10 codes ending in MZ. The code needs a valid check digit.
 */
export function normalizeCorreNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) && number.endsWith('MZ')) return number;
  throw new InvalidInputError(PROVIDER, 'CORRE tracks its own S10 item codes, ending in MZ');
}

/** A record's clock to the minute, with no zone; the reply does not give one. */
function localTime(value: string): string {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) {
    throw new SchemaError(PROVIDER, 'CORRE returned an invalid record time');
  }
  return `${day}T${match[4]}:${match[5]}:00`;
}

/**
 * One record's table: its wording beside the item's code, then the labelled
 * cells after it. Only `DATA`, the clock, is kept; `NO`, the system's name for
 * the counter, and `USER`, the clerk's login, are not.
 */
function recordOf(cells: string[], number: string): CarrierEvent {
  if (cells.length < 4 || cells.length > MAX_FIELDS * 2 || cells.length % 2) {
    throw new SchemaError(PROVIDER, 'CORRE returned a record of an unexpected shape');
  }
  const [description = '', code = ''] = cells;
  if (!description) throw new SchemaError(PROVIDER, 'CORRE returned a record without wording');
  if (normalizeTrackingNumber(code) !== number) throw new IndeterminateError(PROVIDER, 'CORRE answered for a different item');
  const fields = new Map<string, string>();
  for (let at = 2; at < cells.length; at += 2) fields.set(cells[at]!.toUpperCase(), cells[at + 1]!);
  const clock = fields.get('DATA');
  if (clock === undefined) throw new SchemaError(PROVIDER, 'CORRE returned a record without its time');
  const staged = correStage(description);
  return {
    local_time: localTime(clock),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The page of `cgi-bin/tracktrace.cgi?OBJ=` for one code: a table per record
 * the lookup holds for the item, then a link to the scan of its waybill and
 * the time the search took. A code it holds nothing for gets the same page
 * without a table.
 */
export function parseCorre(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCorreNumber(rawNumber);
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CORRE answered with a browser check');
  const $ = load(html);
  if (clean($('title').first().text(), 120) !== TITLE) throw new SchemaError(PROVIDER, 'CORRE returned an unexpected page');
  const page = clean($('body').text(), 4_000);
  if (WRONG_LENGTH.test(page)) throw new InvalidInputError(PROVIDER, 'CORRE says an object code has thirteen characters', { reason: 'wrong_number' });
  const tables = $('table').toArray();
  if (tables.length > MAX_RECORDS) throw new SchemaError(PROVIDER, 'CORRE returned an oversized history');
  if (!tables.length) {
    // Only a search that ran and listed nothing is a missing item.
    if (SEARCHED.test(page)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'CORRE returned a page without a search result');
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  tables.forEach((table) => {
    const cells = $(table).find('td').toArray().map((cell) => clean($(cell).text(), 200));
    const event = recordOf(cells, number);
    // A record the page lists twice is kept once.
    const identity = JSON.stringify([event.local_time, event.description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  // Newest first by clock; records with the same clock keep the page's order.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => {
    const a = String(left.local_time);
    const b = String(right.local_time);
    return a < b ? 1 : a > b ? -1 : 0;
  });

  const latest = events[0]!;
  // A record without a stage keeps the newest staged record's stage.
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
