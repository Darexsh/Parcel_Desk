import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dexpressStage } from './status.js';

export const PROVIDER = 'D Express';
// A reply is under two kilobytes: a short HTML summary and a dozen scans.
export const DEXPRESS_MAX_BYTES = 256 * 1024;
// D Express delivers in Serbia only.
const ZONE = 'Europe/Belgrade';
// Two letters and ten digits: the twelve characters the tracking form requires.
const NUMBER = /^[A-Z]{2}\d{10}$/;
// "20.04.2026 12:12:43"
const CLOCK = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/;
const NOT_FOUND = 'Pošiljka nije pronađena.';
// Where the shipment is: in a centre's warehouse or with one of its couriers, named after its town.
const CENTRE = /^(?:U magacinu centra|Kod kurira centra):\s*(\p{L}[\p{L} .()'-]{0,79})$/u;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A D Express shipment code in capitals, as the page sends it; anything else is not one it issues. */
export function normalizeDexpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'D Express shipment codes are two letters and ten digits');
  return number;
}

/** A wall clock to the second, read in Belgrade. */
function clockOf(value: unknown): ParsedTime {
  const text = typeof value === 'string' ? clean(value, 40) : '';
  // Luxon rolls 24:00 over to the next day.
  const parsed = CLOCK.test(text) && Number(text.slice(11, 13)) < 24 ? zonedTime(text, 'dd.MM.yyyy HH:mm:ss', ZONE) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'D Express returned an invalid scan time');
  return parsed;
}

interface Summary {
  status: string;
  time: ParsedTime | null;
  where: string;
}

/**
 * The summary the page shows above the history, a list of labels and values:
 * the current status, its time and where the shipment is. The recipient, the
 * address, the town, the parcel count and the regional centre's phone are not read.
 */
function summaryOf(html: string): Summary {
  const $ = load(html);
  const lists = $('dl.shipment-track-dl');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'D Express tracking reply changed');
  const fields = new Map<string, string>();
  let label = '';
  lists.children().each((_index, node) => {
    const item = $(node);
    const text = clean(item.text(), 200);
    if (item.is('dt')) label = text.replace(/\s*:$/, '');
    else if (item.is('dd') && label) {
      // The page's own placeholder for a missing value.
      fields.set(label, text === '-' ? '' : text);
      label = '';
    }
  });
  const time = fields.get('Vreme statusa');
  return { status: fields.get('Trenutni status') ?? '', time: time ? clockOf(time) : null, where: fields.get('Lokacija') ?? '' };
}

function scanOf(row: unknown): { event: CarrierEvent; timestamp: number } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'D Express returned an invalid scan');
  const description = typeof row.statusValue === 'string' ? clean(row.statusValue, 200) : '';
  if (!description) throw new SchemaError(PROVIDER, 'D Express returned a scan without wording');
  const clock = clockOf(row.statusTime);
  const staged = dexpressStage(description);
  return {
    timestamp: clock.timestamp,
    event: { time: clock.iso, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
  };
}

/**
 * The reply of the tracking page's `task=search` lookup for one code. An
 * unknown code is `{"flag":false}` with the page's not-found notice; a known
 * one names its code and carries the summary as HTML and the scans oldest
 * first, each a wall clock and a wording.
 */
export function parseDexpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDexpressNumber(raw);
  if (!isRecord(payload) || typeof payload.flag !== 'boolean') throw new SchemaError(PROVIDER, 'D Express returned an invalid envelope');
  if (!payload.flag) {
    if (typeof payload.info === 'string' && clean(payload.info, 200) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'D Express did not complete the lookup');
  }
  if (typeof payload.shipmentCode !== 'string') throw new SchemaError(PROVIDER, 'D Express returned a shipment without its code');
  if (clean(payload.shipmentCode, 64) !== number) throw new IndeterminateError(PROVIDER, 'D Express answered for another shipment');
  if (typeof payload.htmlTable !== 'string') throw new SchemaError(PROVIDER, 'D Express returned a shipment without its summary');
  const summary = summaryOf(payload.htmlTable);
  const rows = payload.historyStatuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'D Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'D Express returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; timestamp: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row);
    const identity = JSON.stringify([scan.event.time, scan.event.description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ ...scan, index });
  });
  // Newest first; scans on the same second keep the reply's order, the later one newer.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = scans.map(({ event }) => event);

  // The current status decides the stage: scans on the same second do not say which came last.
  const current = summary.status ? dexpressStage(summary.status) : null;
  const staged = events.find((event) => event.stage);
  const stage = (current?.stage ?? staged?.stage) as Stage | undefined;
  const source = current ? current.source : staged?.stage_source;
  const newest = events[0];
  if (!newest && !summary.status) throw new NoHistoryError(PROVIDER);

  // The page's line for where the shipment is belongs to the current status.
  const centre = CENTRE.exec(summary.where)?.[1]?.trim();
  if (newest && centre && newest.description === summary.status && newest.time === summary.time?.iso) newest.location = centre;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time ?? summary.time?.iso : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: summary.status || newest!.description!,
    last_update: summary.time?.iso ?? newest?.time ?? null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
