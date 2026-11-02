import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chronodialiMappedStage, chronodialiStage } from './status.js';

export const PROVIDER = 'Chronodiali';
// A history of ten scans is about ten kilobytes.
export const CHRONODIALI_MAX_BYTES = 512 * 1024;
// CHPU and 19 digits, the tracking page's example, or CD and ten digits, which its tracker also knows.
const NUMBER = /^(?:CHPU\d{19}|CD\d{10})$/;
// The tracker's own answer to a number it does not know, with HTTP 400.
const NOT_FOUND = 'Consignment not found';
// The courier's call to the recipient, which the page leaves out too: nothing moves.
const LEFT_OUT = new Set(['call_log']);
// The hub a parcel waits at with a partner, which names no place.
const NO_PLACE = /^3PL\b/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * The page's message for each event type, in lower case. The page shows only
 * the types it has a message for; another type keeps the reply's own label.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  softdata_upload: 'Les données du colis ont été intégrées dans nos systèmes.',
  pickup_scheduled: 'Le ramassage a été programmé.',
  pickup_awaited: 'Le ramassage est en attente, le livreur se présentera sous peu.',
  pickup_completed: 'Le colis a été collecté par le livreur.',
  pkx001: 'Le ramassage a été annulé à la demande du client.',
  pkx002: 'Le ramassage a été annulé : l\'étiquette est manquante ou illisible.',
  pkx003: 'Le ramassage a été annulé : le colis est endommagé et ne peut pas être pris en charge.',
  pkx004: 'Le ramassage a été annulé : le colis dépasse les limites de dimensions et/ou de poids.',
  pkx005: 'Le ramassage a été annulé : l\'emaballage du colis ne permet pas la prise en charge.',
  pkx100: 'Le ramassage a été reprogrammé : une nouvelle date a été définie.',
  pkx101: 'Le ramassage a été reprogrammé : ue nouvelle adresse a été définie.',
  pkx102: 'Le ramassage a été reprogrammé : le colis n\'est pas prêt.',
  pkx103: 'Le ramassage a été reprogrammé par manque de temps du livreur.',
  pkn001: 'Le ramassage a échoué : le client n\'a pas répondu ou était injoignable.',
  pkn002: 'Le ramassage a échoué : le lieu de livraison est incorrect ou introuvable.',
  pkn003: 'Le ramassage a échoué : le client a refusé la prise en charge.',
  pkn004: 'Le ramassage a échoué : le client est indisponible.',
  pkn005: 'Le ramassage a échoué.',
  inscan_at_hub: 'Le colis est arrivé au hub d\'origine.',
  intransittohub: 'Le colis a quitté notre hub.',
  reachedathub: 'Le colis est arrivé au hub.',
  rto: 'Le colis va être renvoyé à l\'expéditeur.',
  on_hold: 'Le colis est retenu au hub.',
  cancelled: 'Le colis a été annulé.',
  shelved: 'Le colis est en attente au hub.',
  assigned_to_third_party: 'Le colis a été assigné à un partenaire tiers.',
  handover_to_third_party: 'Le colis a été confié à un partenaire tiers.',
  outfordelivery: 'Le colis est en cours de livraison.',
  delivered: 'Le colis a été livré.',
  rto_delivered: 'Le colis a été retourné à l\'adresse de l\'expéditeur.',
  rescheduled: 'Le colis a été reprogrammé.',
  den001: 'La livraison a échoué : le client n\'a pas répondu ou était injoignable.',
  den002: 'La livraison a échoué : le lieu de livraison est incorrect ou introuvable.',
  den003: 'La livraison a échoué : le client a refusé le colis.',
  den004: 'La livraison a échoué : le client est indisponible.',
  den005: 'La livraison a échoué : le client n\'a pas le montant COD requis.',
  den006: 'La livraison a échoué.',
  dex001: 'La livraison a été annulée à la demande du client.',
  dex002: 'La livraison a été annulée : le colis est endommagé et ne peut pas être livré.',
  dex100: 'La livraison a été reprogrammée : une nouvelle date a été définie.',
  dex101: 'La livraison a été reprogrammée : ue nouvelle adresse a été définie.',
  dex102: 'La livraison a été reprogrammée par manque de temps du livreur.',
  dex103: 'La livraison a été reprogrammée.',
  arrived_at_airport: 'arrivé à l\'aéroport.',
  arrived_in_country: 'arrivé dans le pays.',
  pending_custom: 'dédouanement en cours',
  shipment_clear_successfully: 'dédouanement terminé',
};

/** A Chronodiali number in upper case, as the page sends it; anything else is not one Chronodiali issues. */
export function normalizeChronodialiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Chronodiali numbers are CHPU and 19 digits, or CD and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Chronodiali returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An event type: the page's message for it, else the reply's own label, else the type itself. */
function wording(code: string, row: Record<string, unknown> = {}): string {
  return MESSAGES[code.toLowerCase()] ?? (text(row, 'status_external') || text(row, 'customer_update') || code);
}

/** `event_time`, epoch milliseconds: an instant. */
function instant(value: unknown): { iso: string; timestamp: number } {
  // Seconds would read as 1970.
  const parsed = typeof value === 'number' && Number.isSafeInteger(value) && value >= 1e12 ? epochMillisTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Chronodiali returned an invalid scan time');
  return parsed;
}

interface Scan { event: CarrierEvent; timestamp: number; code: string }

/**
 * One event: its type, clock and hub. The courier, the recipient's
 * signature and photos, the GPS position, the vehicle and the trip are not read.
 */
function projectEvent(row: Record<string, unknown>): Scan | null {
  const code = text(row, 'type', 64);
  if (!code) throw new SchemaError(PROVIDER, 'Chronodiali returned a scan without its type');
  if (LEFT_OUT.has(code.toLowerCase())) return null;
  const { iso, timestamp } = instant(row.event_time);
  const description = wording(code, row);
  const hub = text(row, 'hub_name', 120);
  const location = NO_PLACE.test(hub) ? '' : hub;
  const staged = chronodialiStage(code, description);
  return { code, timestamp, event: {
    time: iso,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The reply of Shipsy's `consignment/track` for Chronodiali's account. An
 * unknown number is HTTP 400 with `Consignment not found`. A shipment must name
 * the number asked. The reply also holds the sender's and recipient's names,
 * phones and addresses, the cash-on-delivery amount and proof-of-delivery
 * images, none of which is read.
 */
export function parseChronodiali(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChronodialiNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Chronodiali returned an invalid reply');
  if (payload.error !== undefined) {
    if (!isRecord(payload.error)) throw new SchemaError(PROVIDER, 'Chronodiali returned an invalid error');
    if (text(payload.error, 'message') === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Chronodiali did not complete the lookup');
  }
  if (typeof payload.reference_number !== 'string') throw new SchemaError(PROVIDER, 'Chronodiali returned a shipment without its number');
  if (normalizeTrackingNumber(clean(payload.reference_number, 64)) !== number) {
    throw new SchemaError(PROVIDER, 'Chronodiali answered for another shipment');
  }
  const rows = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Chronodiali returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Chronodiali returned an oversized history');
  const summary = text(payload, 'status', 64);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chronodiali returned an invalid scan');
    const scan = projectEvent(row);
    if (!scan) continue;
    const key = JSON.stringify([scan.timestamp, scan.code.toLowerCase(), scan.event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  // Newest first, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.map((scan) => scan.event);

  // The shipment's own status decides the stage; without one it knows, the newest staged scan does.
  const own = summary ? chronodialiMappedStage(summary) : undefined;
  const scanned = events.find((event) => event.stage);
  const stage = (own ?? scanned?.stage) as Stage | undefined;
  const source = own ? 'carrier_map' : scanned?.stage_source;
  const destination = isRecord(payload.destination_details) ? countryCode(text(payload.destination_details, 'country', 8)) : null;
  const facts = {
    ...(stage ? { status: languageStageStatus(stage), current_stage: stage, current_stage_source: source ?? 'carrier_map' } : { status: 'unknown' as const }),
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
  };
  if (!events.length) {
    // A shipment created without a scan yet, which the page reports as being processed.
    if (!own) throw new NoHistoryError(PROVIDER);
    return { ...facts, last_status_text: wording(summary), provider_code: summary, last_update: null, summary_only: true, events: [] };
  }
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    ...facts,
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
