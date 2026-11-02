import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pttStage } from './status.js';

export const PROVIDER = 'PTT';
// A reply with a long history is a few kilobytes.
export const PTT_MAX_BYTES = 512_000;

const MAX_ROWS = 500;
// The service's result codes: the history, a barcode without movements and a barcode it rejects.
const FOUND = 0;
const NO_MOVEMENT = 1;
const INVALID = 2;
// The entered barcode has no movements, in Turkish, which the adapter asks for, or in English.
const NO_MOVEMENT_NOTICE = /^(?:Girilen barkoda ait hareket bulunmamaktad[ıi]r|No tracking history found for the entered barcode)\.?$/i;
const DAY = /^\d{2}\/\d{2}\/\d{4}$/;
const TIME = /^\d{2}:\d{2}(?::\d{2})?$/;
// Abroad, a scan names the country and marks it as abroad, "(Yurt Disi)".
const ABROAD = /\(\s*yurt\s*d[ıi][şs][ıi]\s*\)/giu;

/**
 * PTT's barcodes: a PTT Kargo `KP` number, a thirteen-digit barcode or an
 * S10 item code, the only forms its app's thirteen-character field takes.
 */
export function normalizePttNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^KP\d{11}$/.test(number) || /^\d{13}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'PTT tracks KP numbers, thirteen-digit barcodes and S10 item codes');
}

/** The scan's date and time ("06/10/2026", "18:31:34") as a wall clock. They carry no offset. */
function wallClock(day: string, time: string): string | null {
  if (!DAY.test(day) || !TIME.test(time)) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${day} ${time.length === 5 ? `${time}:00` : time}`, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The scan's wording. A delivery names, after a slash, who signed for the
 * item, masked with asterisks; that is never read.
 */
function wording(raw: string): string {
  let text = raw.replace(/\s+\/\s[\s\S]*$/, '');
  const masked = text.search(/\S*\*/);
  if (masked >= 0) text = text.slice(0, masked);
  return clean(text.replace(/[\s/:-]+$/, ''), 300);
}

/** The office, its province and district, or the country abroad, without empty separators. */
function place(raw: unknown): string {
  return clean(typeof raw === 'string' ? raw.replace(ABROAD, ' ') : raw, 200)
    .replace(/^[\s-]+|[\s-]+$/g, '').replace(/\s+-(?:\s+-)+\s+/g, ' - ');
}

function weightKg(raw: unknown): number | undefined {
  const text = clean(raw, 16);
  // Grams, as the app shows them.
  const grams = /^\d{1,7}$/.test(text) ? Number(text) : Number.NaN;
  return grams > 0 ? grams / 1000 : undefined;
}

/**
 * The tracking service's reply for one barcode: its movements, newest first,
 * each with PTT's wording, office and wall clock. The masked names of the
 * sender, the recipient and whoever signed for the item, the postage and the
 * offices of acceptance and delivery are never read.
 */
export function parsePtt(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePttNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'PTT returned no tracking result');
  const code = payload.sonucKodu;
  if (typeof code !== 'number' || !Number.isInteger(code)) throw new SchemaError(PROVIDER, 'PTT returned no result code');
  // The reply names the barcode it answers for, also when the barcode has no movements.
  const echoed = payload.BARNO;
  const named = typeof echoed === 'string' ? normalizeTrackingNumber(echoed) : '';
  if ((echoed != null && typeof echoed !== 'string') || (named && named !== number)) {
    throw new SchemaError(PROVIDER, 'PTT answered for a different barcode');
  }
  const notice = clean(payload.sonucAciklama, 200);
  // Only the service's own "no movements" notice is a missing item.
  if (code === NO_MOVEMENT) {
    if (NO_MOVEMENT_NOTICE.test(notice)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'PTT returned a notice instead of the item history');
  }
  // "Geçersiz Barkod.": a barcode PTT does not issue.
  if (code === INVALID) throw new InvalidInputError(PROVIDER, 'PTT does not recognize the barcode', { reason: 'wrong_number' });
  if (code !== FOUND) throw new IndeterminateError(PROVIDER, `PTT answered with result ${code}`);
  if (named !== number) throw new SchemaError(PROVIDER, 'PTT returned a history without its barcode');
  const rows = payload.dongu;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PTT returned an invalid item history');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'PTT returned no movements for the barcode');

  const scans: { event: CarrierEvent; order: number }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.ISLEM !== 'string') throw new SchemaError(PROVIDER, 'PTT returned an invalid movement');
    const time = wallClock(clean(row.ITARIH, 16), clean(row.ISAAT, 16));
    const description = wording(row.ISLEM);
    if (!time || !description) throw new SchemaError(PROVIDER, 'PTT returned a movement without a clock or wording');
    const location = place(row.IMERK);
    const event: CarrierEvent = { local_time: time, description, ...(location ? { location } : {}) };
    // A parcel can repeat a movement with the same clock, office and wording.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    // The service numbers its movements in the order it recorded them.
    const sequence = typeof row.siraNo === 'number' && Number.isFinite(row.siraNo) ? row.siraNo : rows.length - index;
    scans.push({ event, order: sequence });
  });
  // Newest first; equal clocks keep the order PTT recorded them in.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : right.order - left.order);
  const events = scans.map(({ event }) => event);
  for (const event of events) {
    const classified = pttStage(event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
  }

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The office an item waits at is its pickup point. A delivered item was
  // collected there when it waited there last before the delivery.
  const earlier = events.slice(1);
  const waiting = stage === 'ready_for_pickup' ? latest
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup')
      : undefined;
  const point = waiting?.location ?? '';
  const weight = weightKg(payload.GR);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}
