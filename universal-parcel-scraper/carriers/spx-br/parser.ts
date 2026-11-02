import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { isSpxHiddenMilestone } from '../spx-id/codes.js';
import { spxBrStage } from './status.js';

export const PROVIDER = 'SPX Express Brazil';
// A long cross-border history in Portuguese is under fifty kilobytes.
export const SPX_BR_MAX_BYTES = 1_000_000;
// BR, twelve digits and a final digit or letter: the numbers the tracker's links carry.
const NUMBER = /^BR\d{12}[0-9A-Z]$/;
// The order index's own count of parcels under the number: none.
const UNKNOWN = /GetLogisticOrderIndexMap[\s\S]*\bfind \[0\]/;
const CODE = /^[A-Z0-9_]{1,16}$/;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
// Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres, on
// the way out and back. Pickups, deliveries and the return to the seller
// name the seller's or the recipient's town, which is not kept.
const FACILITY = /^F(?:[2-5]\d\d|67\d|680)$/;
// Wordings that name the centre, origin or port of their scan after a colon:
// "Seu pedido saiu do centro logístico: Cidade Exemplo - SP", and the arrival
// "O pedido chegou ao centro de : Cidade Exemplo - SP e segue para a próxima etapa.".
const PLACED = [
  /^(.*\b(?:centro log[ií]stico|origem|porto de tr[âa]nsito))\s*:\s*([^:]*\S)$/i,
  /^(O pedido chegou ao centro) de\s*:\s*(\S.*?)( e segue para a próxima etapa\.?)$/i,
];

// A posting names the town of the point where the seller dropped the parcel off after its
// wording ("Pedido postado Cidade Exemplo - SP"): the seller's town, which a pickup keeps none of.
const POSTED = /^(Pedido postado)\s+\S.*\s-\s[A-Z]{2}$/i;

/** A posting's wording without the town of its drop-off point. */
export function spxBrPostedText(wording: string): string {
  return wording.replace(POSTED, '$1');
}

/** A number for SPX Brazil's tracker; anything else is not one it issues. */
export function normalizeSpxBrNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SPX Express Brazil numbers are BR, twelve digits and a final digit or letter');
  return number;
}

// Who took the parcel: "Recebido por: …" after a delivery, or the bracketed
// name the tracker's pt-BR wording puts after "entregue a".
const RECEIVER = /\s*[.,;]?\s*\b(?:recebid[oa]|retirad[oa]|assinad[oa]) por\s*:[\s\S]*$/i;
const NAMED = /\b(entregue)\s+(?:a|ao|à|para)\s+\[[^\]]*\][\s\S]*$/i;

/** A scan's wording without the name of whoever took the parcel. */
export function spxBrWording(text: string): string {
  // A line whose template left its place empty ("está a caminho .") ends on a spaced stop.
  return clean(clean(text, 1000).replace(RECEIVER, '').replace(NAMED, '$1'), 500).replace(/[\s,;:]+$/, '').replace(/\s+\.$/, '.');
}

/**
 * A facility scan's wording without the centre, origin or port it names, and
 * that place, so the wording reads the same from town to town.
 */
export function spxBrPlacedText(wording: string): { description: string; location: string } {
  for (const pattern of PLACED) {
    const match = pattern.exec(wording);
    if (match) return { description: match[1]!.trim() + (match[3] ?? ''), location: match[2]!.trim() };
  }
  return { description: wording, location: '' };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SPX Express Brazil returned an invalid ${key}`);
  return value;
}

function projectRow(row: Record<string, unknown>): CarrierEvent | null {
  // The page leaves out the rows SPX flags hidden; its milestones among them stay.
  if (row.display_flag === 0 && !isSpxHiddenMilestone(row)) return null;
  const code = text(row, 'tracking_code').trim().toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid tracking code');
  // A few scans have no line of their own; their English tracking name stands in.
  const description = spxBrWording(text(row, 'description')) || clean(text(row, 'tracking_name'), 200);
  if (!description) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a scan without wording');
  const clock = row.actual_time;
  const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000
    ? epochSecondsTime(clock)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan time');
  const facility = FACILITY.test(code);
  // The reply's place stands; a place named only in the wording stands in for it.
  const named = facility ? spxBrPlacedText(description) : { description: spxBrPostedText(description), location: '' };
  const place = facility && isRecord(row.current_location) ? row.current_location : null;
  const location = (place ? clean(text(place, 'location_name'), 120) : '') || clean(named.location, 120);
  const point = place && location ? eventPoint(place.lat, place.lng) : null;
  const staged = spxBrStage(code, named.description);
  return {
    time, ...(location ? { location } : {}), ...(point ? { point } : {}), description: named.description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the tracker's `get_order_info` for one number. A number SPX
 * does not know fails with the order index's count of none, which the page
 * reports as no result; any other failure is inconclusive. The tracking
 * object must name the number asked.
 */
export function parseSpxBr(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSpxBrNumber(raw);
  if (!isRecord(payload) || typeof payload.retcode !== 'number') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid envelope');
  if (payload.retcode !== 0) {
    if (typeof payload.message === 'string' && UNKNOWN.test(payload.message)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'SPX Express Brazil did not complete the lookup');
  }
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned no tracking data');
  const tracking = payload.data.sls_tracking_info;
  if (tracking === undefined || tracking === null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(tracking) || typeof tracking.sls_tn !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment without its number');
  if (normalizeTrackingNumber(clean(tracking.sls_tn, 64)) !== number) throw new IndeterminateError(PROVIDER, 'SPX Express Brazil answered for another shipment');
  const rows = tracking.records ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SPX Express Brazil returned an invalid scan');
    const event = projectRow(row);
    if (!event) continue;
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Every scan is an instant. The reply lists a customs check filed late
  // among later scans; newest first by the clock, the order stays stable.
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
