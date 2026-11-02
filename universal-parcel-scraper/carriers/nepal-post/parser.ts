import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { nepalPostStage } from './status.js';

export const PROVIDER = 'Nepal Post';
const HEADINGS = ['SN.', 'Event Type', 'Event Date', 'User', 'Event Office', 'Next Office', 'Condition', 'Retention Reason'];
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt/i;

export function nepalPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Nepal Post requires a postal S10 item');
}

/** PITS is the national internal system, with local Nepal scan clocks. */
export function parseNepalPost(html: string, raw: string): CarrierResult {
  const number = nepalPostNumber(raw);
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nepal Post answered with a block page');
  const $ = load(html);
  const input = $('input#ItemId[name="ItemId"]');
  if (input.length !== 1) throw new SchemaError(PROVIDER, 'Nepal Post returned no tracking form');
  const echoed = input.attr('value') ?? '';
  if (echoed.length > 64 || normalizeTrackingNumber(echoed) !== number) throw new IndeterminateError(PROVIDER, 'Nepal Post answered for another item');
  const tables = $('table').filter((_, element) => /^Event Details\s*:/i.test($(element).find('tr').first().text().trim()));
  if (!tables.length && $('p').toArray().some(element => clean($(element).text(), 100) === 'No Events Found')) throw new NotFoundError(PROVIDER);
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Nepal Post returned no event table');
  const rows = tables.find('tr').toArray();
  const header = $(rows[0]).text().trim().replace(/\s+/g, ' ');
  if (header !== `Event Details : ${number}`) throw new IndeterminateError(PROVIDER, 'Nepal Post returned a table for another item');
  const headings = $(rows[1]).find('th,td').toArray().map(cell => clean($(cell).text(), 100));
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS) || rows.length > 502) throw new SchemaError(PROVIDER, 'Nepal Post changed its event table');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(2)) {
    const cells = $(row).children('td');
    if (cells.length !== 8 || !/^\d{1,4}$/.test(cells.eq(0).text().trim())) throw new SchemaError(PROVIDER, 'Nepal Post returned an invalid event row');
    const description = clean(cells.eq(1).text(), 320);
    const written = cells.eq(2).text().trim();
    if (!description || !/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M$/.test(written)) throw new SchemaError(PROVIDER, 'Nepal Post returned an invalid event');
    const date = firstOccurrence(DateTime.fromFormat(written, 'M/d/yyyy h:mm:ss a', { zone: 'Asia/Kathmandu', locale: 'en' }));
    if (!date.isValid) throw new SchemaError(PROVIDER, 'Nepal Post returned an invalid scan calendar');
    const location = clean(cells.eq(4).text(), 160);
    const staged = nepalPostStage(description);
    const event: CarrierEvent = { local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), time: date.toISO({ suppressMilliseconds: true }),
      time_zone: 'Asia/Kathmandu', time_zone_basis: 'carrier', description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const newest = events[0]!;
  const staged = nepalPostStage(newest.description!);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: newest.time, last_update_local: newest.local_time,
    expected_delivery: null, events: events.slice(0, 100), history_truncated: true,
    ...(newest.stage === 'delivered' ? { delivered_at: newest.time } : {}) };
}
