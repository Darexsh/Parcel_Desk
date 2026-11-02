/**
 * Paack parcels that Evri International hands over, tracked without the
 * delivery postcode.
 *
 * Paack gives these parcels a number of its own, `PK` and 18 digits, and
 * Evri International's tracker finds a parcel by its delivery partner's number
 * as well as by its Evri barcode. The reply is Evri's whole journey: its own
 * scans up to the hand-over, then Paack's, on offset-less wall clocks. Paack's,
 * from "Arrived In Country" on, have the digits of Paack's own UTC instants to
 * the second, so they become instants. Evri's keep their wall clocks.
 */
import type { TrackingContext } from '../../core/adapter/index.js';
import { SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { fetchEvriInternational } from '../evri/adapter.js';
import { evriPartner, parseEvriInternational } from '../evri/parser.js';

/** The number Paack prints on a parcel from Evri International; the catalog's `paack-1` rule. */
export const PAACK_EVRI_NUMBER = /^PK\d{18}$/;

/**
 * Evri International's reply for a Paack number. The tracker would also find
 * the parcel by its Evri barcode, so the reply counts only when its whole
 * Carrier Tracking value is the number asked and its Carrier field names
 * Paack. "Parcel not found" stays not-found.
 */
export function parsePaackEvriReply(html: string, number: string): CarrierResult {
  const shipment = parseEvriInternational(html, number);
  if (shipment.carrierTracking !== number || evriPartner(shipment.carrierLabel) !== 'paack') {
    throw new SchemaError('Paack', 'Evri International returned a parcel another carrier delivers');
  }
  return paackLegInstants(shipment.result);
}

/** The newest-first reply with Paack's scans, from its arrival in the country on, read as UTC. */
function paackLegInstants(result: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  const arrival = events.findIndex((event) => event.description === 'Arrived In Country');
  if (arrival < 0) return result;
  const dated = events.map((event, index): CarrierEvent => {
    if (index > arrival || typeof event.local_time !== 'string') return event;
    const instant: CarrierEvent = { ...event, time: new Date(`${event.local_time}Z`).toISOString() };
    delete instant.local_time;
    return instant;
  });
  const newest = dated[0]!.time;
  const instants: CarrierResult = { ...result, last_update: typeof newest === 'string' ? newest : null, events: dated };
  if (instants.last_update) delete instants.last_update_local;
  return instants;
}

export async function trackPaackThroughEvri(
  number: string,
  context: Required<Pick<TrackingContext, 'budgetMs'>> & TrackingContext,
  options: { fetcher?: typeof fetch; userAgent?: string } = {},
): Promise<CarrierResult> {
  const html = await fetchEvriInternational(number, { budgetMs: context.budgetMs, signal: context.signal, ...options });
  return parsePaackEvriReply(html, number);
}
