import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dhlEcommercePlStatus, statusForStage } from './status.js';

const PROVIDER = 'DHL eCommerce Poland';
const ZONE = 'Europe/Warsaw';
const MAX_NUMBER = 1_000_000;
/** Stages that end a parcel's journey; no delivery is planned after them. */
const FINAL: readonly Stage[] = ['delivered', 'returned'];

export interface DhlEcommercePlChallenge { algorithm: 'SHA-256'; challenge: string; salt: string; signature: string; maxnumber: number }

/**
 * What the portal's form takes: a waybill, a parcel licence plate or an order
 * reference. `AD` numbers are Allegro Delivery's and the portal sends their
 * owner to Allegro.
 */
export function normalizeDhlEcommercePlNumber(raw: string): string {
  const number = raw.trim().toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{11,34}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'DHL eCommerce Poland tracking requires a number of 11 to 34 letters and digits');
  }
  if (number.startsWith('AD')) throw allegroDelivery();
  return number;
}

/** Another carrier's number, refused with the reason `other_carrier` rather than as a wrong number. */
function allegroDelivery(): InvalidInputError {
  return new InvalidInputError(PROVIDER, 'This number belongs to Allegro Delivery, which Allegro tracks', { reason: 'other_carrier' });
}

/** The proof of work the page receives before a lookup; only the published SHA-256 form is solved. */
export function parseDhlEcommercePlChallenge(payload: unknown): DhlEcommercePlChallenge {
  if (!isRecord(payload) || payload.algorithm !== 'SHA-256'
    || typeof payload.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(payload.challenge)
    || typeof payload.salt !== 'string' || !/^[0-9a-f]{8,128}(?:\?[\w=&.-]{1,160})?$/.test(payload.salt)
    || typeof payload.signature !== 'string' || !/^[0-9a-f]{16,128}$/.test(payload.signature)
    || !Number.isInteger(payload.maxnumber) || (payload.maxnumber as number) < 1 || (payload.maxnumber as number) > MAX_NUMBER) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Poland returned an invalid request challenge');
  }
  return { algorithm: 'SHA-256', challenge: payload.challenge, salt: payload.salt, signature: payload.signature, maxnumber: payload.maxnumber as number };
}

/** A 422 that names the submitted number is the portal refusing its format; any other says nothing about the parcel. */
export function parseDhlEcommercePlRejection(payload: unknown): never {
  if (isRecord(payload) && payload.code === 422 && isRecord(payload.errors) && Array.isArray(payload.errors.number1)) {
    throw new InvalidInputError(PROVIDER, 'DHL eCommerce Poland does not accept this tracking number', { reason: 'wrong_number' });
  }
  throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned an inconclusive tracking error');
}

function instant(value: unknown): { iso: string; day: string } | undefined {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? explicitOffsetTime(value) : null;
  return time ? { iso: time.iso, day: new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(time.timestamp) } : undefined;
}

export function parseDhlEcommercePl(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDhlEcommercePlNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'DHL eCommerce Poland returned an invalid tracking response');
  const entry: unknown = payload[0];
  if (payload.length !== 1 || !isRecord(entry) || typeof entry.number !== 'string' || entry.number.toUpperCase() !== number
    || !Array.isArray(entry.shipments)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Poland did not return the requested number');
  }
  if (entry.numberType === 'AllegroDelivery') throw allegroDelivery();
  if (!entry.shipments.length) {
    // The portal leaves the number type out when it knows nothing under the number.
    if (entry.numberType === undefined) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned no shipment for a number it recognizes');
  }
  // An order can hold several parcels and the answer does not say which one was asked for.
  if (entry.shipments.length > 1) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Poland returned several shipments for one number');
  const shipment: unknown = entry.shipments[0];
  if (!isRecord(shipment) || typeof shipment.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(shipment.status)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Poland returned an invalid shipment status');
  }
  // The sender is the name the portal shows; self-service links stay out of results.
  const sender = clean(shipment.sender, 200);
  const { description, stage } = dhlEcommercePlStatus(shipment.status, shipment.timelineStep, clean(shipment.title, 200) || clean(shipment.step, 200));
  // Only a receipt is timed, by the recipient or by the sender a return reached. The posting
  // date is a day, and no other status says when it was reached.
  const received = stage && FINAL.includes(stage) ? instant(shipment.receiptDateUtc)?.iso : undefined;
  const planned = instant(shipment.planOfDeliveryFromUtc)?.day ?? instant(shipment.deliveryDateUtc)?.day;
  return {
    status: stage ? statusForStage(stage) : shipment.timelineStep === 'None' ? 'pending' : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: description,
    last_update: received ?? null,
    expected_delivery: stage && FINAL.includes(stage) ? null : planned ?? null,
    ...(received && stage === 'delivered' ? { delivered_at: received } : {}),
    ...(sender ? { sender_name: sender } : {}),
    summary_only: true,
    events: [],
  };
}
