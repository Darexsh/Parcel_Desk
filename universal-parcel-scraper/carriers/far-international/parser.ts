import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { farStage } from './status.js';

export const PROVIDER = 'FAR International';
// A parcel's page is some twenty kilobytes.
export const FAR_MAX_BYTES = 1024 * 1024;

// FAR, two letters, ten digits and YQ, as the catalog's `far-international-1` rule reads them.
const NUMBER = /^FAR[A-Z]{2}\d{10}YQ$/;
const COLUMNS = '轨迹时间|轨迹地点|轨迹时区|轨迹描述';
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/;
const OFFSET = /^(?:GMT|UTC) ?([+-])(\d{1,2})(?::?([0-5]\d))?$/i;
// The last-mile carrier's number, when it is not FAR's own.
const ONWARD = /^[A-Z0-9]{8,40}$/;
// A Chinese scan with its English translation: the English is kept.
const BILINGUAL = /^[^A-Za-z]*\p{Script=Han}[^A-Za-z]*?\s+([A-Za-z][^\p{Script=Han}]*)$/u;
// Who took a delivered parcel, as a delivery scan can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A FAR waybill number; anything else is not one its tracker answers. */
export function normalizeFarNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FAR International waybills are FAR, two letters, ten digits and YQ');
  return number;
}

/** A scan's clock: an instant at the offset the tracker states, else the wall clock alone. */
function scanTime(clock: string, zone: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const parts = CLOCK.exec(clock);
  const local = parts && `${parts[1]}T${parts[2]}${parts[3] ?? ':00'}`;
  if (!local || !DateTime.fromISO(local, { zone: 'UTC' }).isValid) throw new SchemaError(PROVIDER, 'FAR International returned an invalid scan time');
  if (!zone) return { local_time: local };
  const offset = OFFSET.exec(zone);
  if (!offset || Number(offset[2]) > 14) throw new SchemaError(PROVIDER, 'FAR International returned an invalid scan zone');
  const time = explicitOffsetTime(`${local}${offset[1]}${offset[2]!.padStart(2, '0')}:${offset[3] ?? '00'}`)?.iso;
  if (!time) throw new SchemaError(PROVIDER, 'FAR International returned an invalid scan time');
  return { time };
}

/** "【San Francisco,CA,US】" as "San Francisco, CA, US". */
function place(text: string): string {
  return clean(text.replace(/[【】]/g, ''), 120).split(',').map((part) => part.trim()).filter(Boolean).join(', ').slice(0, 100);
}

/**
 * The tracking page's result for one number: the waybill and last-mile
 * numbers, a status, and the scans with their clock, place, offset and
 * wording. A number the tracker has nothing for gets an empty list. Only the
 * entry that names the whole number asked is read.
 */
export function parseFar(html: string, raw: string): CarrierResult {
  const number = normalizeFarNumber(raw);
  const $ = load(html);
  const container = $('.search_resultcon');
  if (container.length !== 1) throw new SchemaError(PROVIDER, 'FAR International returned a page without its results');
  const entries = container.find('> ul > li').toArray();
  if (!entries.length) {
    if (/暂无内容/.test(container.text())) throw new NoHistoryError(PROVIDER);
    throw new SchemaError(PROVIDER, 'FAR International returned an empty result');
  }
  const bound = entries.filter((entry) => normalizeTrackingNumber(clean($(entry).find('> h4 > span').first().text(), 64)) === number);
  if (bound.length !== 1) throw new SchemaError(PROVIDER, 'FAR International did not answer for the waybill asked');
  const entry = $(bound[0]);
  const header = entry.find('.search_resultxlcon > h5 > span').toArray().map((cell) => clean($(cell).text(), 20)).join('|');
  if (header !== COLUMNS) throw new SchemaError(PROVIDER, 'FAR International changed its scan columns');
  const rows = entry.find('.search_resultxlcon > dl > dd').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FAR International returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('span').toArray().map((cell) => $(cell).text());
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'FAR International returned an incomplete scan');
    const time = scanTime(clean(cells[0], 32), clean(cells[2], 16));
    const shown = clean(cells[3], 300);
    // A row without wording says nothing.
    if (!shown) continue;
    const wording = BILINGUAL.exec(shown)?.[1]?.trim() || shown;
    const worded = farStage(wording);
    // Who took a delivery is left out, and the rest staged again.
    const description = worded?.stage === 'delivered' ? clean(wording.replace(RECEIVER, ''), 300) || wording : wording;
    const staged = description === wording ? worded : farStage(description) ?? worded;
    const location = place(cells[1]!);
    const key = JSON.stringify([time.time ?? time.local_time, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ ...time, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The page lists the newest first. Scans that all state their offset are ordered by instant;
  // a wall clock without one keeps the page's order.
  if (events.every((event) => event.time)) {
    const at = new Map(events.map((event, index) => [event, { ms: Date.parse(event.time!), index }]));
    events.sort((left, right) => at.get(right)!.ms - at.get(left)!.ms || at.get(left)!.index - at.get(right)!.index);
  }
  const newest = events[0]!;
  // The last-mile label, listed after the parcel has reached the departure hub, is no step back.
  const staged = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const onward = entry.find('.search_resulttop > h2').toArray().map((line) => $(line))
    .filter((line) => clean(line.children('span').first().text(), 20) === '尾程单号：')
    .map((line) => normalizeTrackingNumber(clean(line.clone().children().remove().end().text(), 64)))[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && staged!.time ? { delivered_at: staged!.time } : {}),
    ...(onward && onward !== number && ONWARD.test(onward) ? { delivery_tracking_number: onward } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
