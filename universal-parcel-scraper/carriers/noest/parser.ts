import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { noestRequestNumber } from './number.js';
import { noestStage } from './status.js';

export const PROVIDER = 'NOEST Express';
// The page is about two hundred kilobytes, most of it the site's list of routes.
export const NOEST_MAX_BYTES = 1024 * 1024;
const ZONE = 'Africa/Algiers';
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Laravel's form token: forty letters and digits.
const TOKEN = /^[A-Za-z0-9]{20,100}$/;
// A CDN's or firewall's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const FORM = 'form[action$="/list/t"]';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

function trackerForm($: CheerioAPI, html: string): Cheerio<AnyNode> {
  const form = $(FORM);
  if (form.length === 1) return form;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'NOEST answered with a browser check');
  throw new SchemaError(PROVIDER, 'NOEST did not return its tracking page');
}

/** The token of the tracking page's form, which belongs to the session the page opened. */
export function noestFormToken(html: string): string {
  const $ = load(html);
  const token = trackerForm($, html).find('input[name="_token"]').attr('value') ?? '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'NOEST’s tracking page has no form token');
  return token;
}

/**
 * A row's clock: the tracker's wall clock to the second, which is Algeria's.
 * Algeria keeps one offset all year.
 */
function scanTime(text: string): string {
  const wall = CLOCK.test(text) ? firstOccurrence(DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm:ss', { zone: ZONE })) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const iso = wall?.isValid && wall.toFormat('yyyy-MM-dd HH:mm:ss') === text ? wall.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'NOEST returned an invalid event time');
  return iso;
}

/** The answer box's history, newest first: each row's clock and wording, without the note under it. */
function history($: CheerioAPI, box: Cheerio<AnyNode>): CarrierEvent[] {
  const table = box.find('table');
  const headings = table.first().find('thead th').toArray().map((cell) => clean($(cell).text(), 40).toLowerCase());
  if (table.length !== 1 || headings[0] !== 'date et heure' || headings[1] !== 'statut') {
    throw new SchemaError(PROVIDER, 'NOEST returned an unexpected history table');
  }
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'NOEST returned an oversized history');
  const scans: { time: string; timestamp: number; order: number; description: string }[] = [];
  const seen = new Set<string>();
  for (const [order, row] of rows.entries()) {
    const cells = $(row).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'NOEST returned an invalid history row');
    // The note under the wording, and who acted in the next column, are not kept.
    const status = cells.eq(1).clone();
    status.find('small').remove();
    const description = clean(status.text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'NOEST returned an event without wording');
    const time = scanTime(clean(cells.eq(0).text(), 32));
    const key = `${time}\n${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ time, timestamp: DateTime.fromISO(time).toMillis(), order, description });
  }
  // Newest first; a later row of the same second comes first.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.order - left.order);
  return scans.map(({ time, description }) => {
    const staged = noestStage(description);
    return { time, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
}

/**
 * The page the tracker's form answers with, `POST /list/t`: the form again
 * with the numbers it was given, and above it a box for each of them NOEST
 * holds, headed with the number and listing its events oldest first. A number
 * it does not hold gets no box. Only the box for the whole number asked is
 * read, and an answer without one counts as not found only when the form
 * shows that number back.
 */
export function parseNoest(html: string, raw: string): CarrierResult {
  const number = noestRequestNumber(raw);
  const $ = load(html);
  const field = trackerForm($, html).find('textarea[name="tracking"]');
  if (field.length !== 1) throw new SchemaError(PROVIDER, 'NOEST did not return its tracking form');
  const boxes = $('h3 > i.fa-hashtag').closest('div.border').toArray().map((node) => $(node));
  if (!boxes.length) {
    if (clean(field.text(), 64) !== number) throw new SchemaError(PROVIDER, 'NOEST did not look the number up');
    throw new NotFoundError(PROVIDER);
  }
  const own = boxes.filter((box) => clean(box.find('h3 > span').first().text(), 64) === number);
  if (!own.length) throw new IndeterminateError(PROVIDER, 'NOEST answered for another shipment');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'NOEST showed several shipments for the number');

  const events = history($, own[0]!);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
