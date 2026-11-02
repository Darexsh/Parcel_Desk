import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaRomanaStage } from './status.js';

export const PROVIDER = 'Poșta Română';
// A reply of a few dozen scans is under 10 kB.
export const POSTA_ROMANA_MAX_BYTES = 256_000;

const MAX_SCANS = 500;
const MAX_EVENTS = 100;
// The tracker shows only scans in Romania.
const ZONE = 'Europe/Bucharest';
const DAY = /^\d{2}\.\d{2}\.\d{4}$/;
const CLOCK = /^\d{2}:\d{2}$/;
// The site a scan names, after a dash; "Plecat din" (left from) leads a departure's.
const SITE = /^-\s*(?:plecat din\s+)?/i;

/**
 * Poșta Română's tracker takes S10 item codes, its own and other posts'
 * while the item is in Romania, and two letters and eleven digits for some
 * domestic parcels.
 */
export function normalizePostaRomanaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^[A-Z]{2}\d{11}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Poșta Română tracks S10 item codes and two letters followed by eleven digits');
}

/**
 * The reply for one item: a summary and its scans oldest first, each with a
 * Romanian wall clock and the site after a dash. An unknown code and the code
 * of unregistered mail come back with flags instead.
 */
export function parsePostaRomana(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePostaRomanaNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.found !== 'boolean') throw new SchemaError(PROVIDER, 'Poșta Română returned an invalid reply');
  if (!payload.found) {
    // The tracker says unregistered mail keeps no history, whatever the code.
    if (payload.trimitereSimpla === true) throw new IndeterminateError(PROVIDER, 'Poșta Română keeps no history for unregistered mail');
    throw new NotFoundError(PROVIDER);
  }
  const answered = typeof payload['Numarul trimiterii'] === 'string' ? normalizeTrackingNumber(payload['Numarul trimiterii'].trim()) : '';
  if (answered !== number) throw new SchemaError(PROVIDER, 'Poșta Română answered for a different item');
  const details = payload.details;
  if (!Array.isArray(details) || details.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Poșta Română returned an invalid item history');

  const scans: { event: CarrierEvent; timestamp: number; index: number }[] = [];
  const seen = new Set<string>();
  details.forEach((detail, index) => {
    if (!isRecord(detail)) throw new SchemaError(PROVIDER, 'Poșta Română returned an invalid scan');
    const day = clean(detail.data, 16);
    const hour = clean(detail.ora, 8);
    const description = clean(detail.detaliu, 300);
    const clock = DAY.test(day) && CLOCK.test(hour) ? zonedTime(`${day} ${hour}`, 'dd.MM.yyyy HH:mm', ZONE) : null;
    if (!clock || !description) throw new SchemaError(PROVIDER, 'Poșta Română returned a scan without a clock or wording');
    const site = clean(detail.unitatePostala, 160).replace(SITE, '').trim();
    const event: CarrierEvent = { time: clock.iso, description, ...(site ? { location: site } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, timestamp: clock.timestamp, index });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Poșta Română returned no scans');
  // Oldest first, as the tracker lists them; equal clocks keep its order.
  scans.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);

  // An acceptance once the item moved is its sender's post taking it back, and
  // a delivery once it was sent back reaches its sender.
  let moved = false;
  let returning = false;
  for (const { event } of scans) {
    const classified = postaRomanaStage(event.description!);
    if (!classified) continue;
    let stage: Stage = classified.stage;
    if (stage === 'accepted' && moved) stage = 'in_transit';
    if (stage === 'delivered' && returning) stage = 'returned';
    if (stage !== 'accepted') moved = true;
    if (stage === 'returned') returning = true;
    Object.assign(event, { stage, stage_source: classified.source });
  }
  const events = scans.reverse().map(({ event }) => event);

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The office an item waits at is its pickup point. A delivered item was
  // collected there when it waited there last; a return's is the sender's.
  const earlier = events.slice(1);
  const waiting = returning ? undefined : stage === 'ready_for_pickup' ? latest
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup') : undefined;
  const point = waiting?.location ?? '';
  const summary = isRecord(payload.summary) ? payload.summary : {};
  const service = clean(summary['Denumire serviciu'], 100);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: latest.time! } : {}),
    ...(service ? { service_name: service } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
