
import { DateTime } from 'luxon';
import { lookupBudget, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierLinkRules, matchesDomain } from '../../core/catalog/linkRules.js';
import { isValidHermesParcelNumber, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  COLLECTED_AT_PARCELSHOP, DELIVERED_ABROAD, hermesGermanyMilestone, IGNORED_BOOKING_STATUS, IN_PARCELBOX, type Milestone,
  NOT_COLLECTED_ABROAD, RETURN_HANDOVER,
} from './status.js';

// Public recipient protocol inspected 2026-09-08:
// https://gcp-prd.my-deliveries.de/tnt/bundle/tnt-bundle-v2.js
// Separate from Hermes Einrichtungs-Service (myhes.de). The postcode-protected
// address endpoint is deliberately not called.
const API = 'https://api.my-deliveries.de/tnt/v2/shipments/search/';
const PROVIDER = 'Hermes Germany tracking';
const CARRIER = 'Hermes Germany';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HermesGermanyOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export { STATUSES } from './status.js';

function etaDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const raw = clean(value, 64);
  if (!raw) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (parsed.isValid) return parsed.toISODate();
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : null;
}

/** Kept as a named class: the grouped live suite asserts this error's name. */
export class HermesGermanyTrackingError extends NotFoundError {
  constructor() {
    super(CARRIER);
    this.name = 'HermesGermanyTrackingError';
  }
}

export function normalizeHermesGermanyNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{8,20}$/.test(value)) {
    throw new InvalidInputError(CARRIER, 'Hermes Germany requires an 8-to-20-character tracking number');
  }
  return value;
}

/**
 * The ParcelShop holding the parcel, or the one it was collected from: its
 * name, street and town. Only a ParcelShop address is read; any other address
 * type is the recipient's or a neighbour's and is never touched.
 */
function parcelShop(parcel: Record<string, unknown>, latest: { metadata?: Milestone; event: CarrierEvent }): string | null {
  const address = isRecord(parcel.address) ? parcel.address : {};
  if (address.addressType !== 'PARCELSHOP') return null;
  const atShop = latest.metadata?.stage === 'ready_for_pickup'
    || COLLECTED_AT_PARCELSHOP.has(String(latest.event.provider_code));
  if (!atShop) return null;
  const name = clean(address.lastName, 120);
  if (!name) return null;
  const town = [clean(address.zipCode, 16), clean(address.city, 80)].filter(Boolean).join(' ');
  return [name, clean(address.street, 120), town].filter(Boolean).join('\n');
}

// Rows carry no location field, but their wording, in English or German,
// names the depot, the destination region or country, or the ParcelShop's address.
const DEPOT_PLACES = [
  /\btaken over by Hermes in (.+?) and is prepared\b/i,
  /\bprepared in (.+?) for further shipping\b/i,
  /\barrived in the destination region (.+?)\.?$/i,
  /^Die Sendung wurde von Hermes in (.+?) übernommen\b/i,
  /^Die Sendung wurde in (.+?) für den Weiterversand vorbereitet\b/i,
  /\bin der Zielregion (.+?) angekommen\b/i,
];
const COUNTRY_PLACES = [
  /\barrived in the destination country (.+?)(?: and is prepared\b|\.?$)/i,
  /\bfor further shipping \(([^()]+)\)/i,
  /\bim Zielland (.+?) angekommen\b/i,
  /\bfür den Weiterversand vorbereitet \(([^()]+)\)/i,
];
// The town after the postcode closing a ParcelShop's address, before the
// collection deadline the ready-for-pickup wording appends or the German verb.
const SHOP_TOWN = /,\s*\d{5}\s+([^\d,]+?)(?:\s+max\.\s.*|\s+abgegeben|\s+erfolgreich abgeholt)?\.?\s*$/;

/**
 * Where a row's wording puts the parcel. Hermes's own depots and ParcelShops
 * are in Germany. A partner's scan (`INTERNATIONAL_…`) names the country after
 * its depot, "prepared in EXEMPLEVILLE for further shipping (France)",
 * or the country alone.
 */
function wordedPlace(text: string, code: string): string | null {
  const place = (pattern: RegExp) => clean(pattern.exec(text)?.[1], 120);
  const country = COUNTRY_PLACES.map(place).find(Boolean) ?? '';
  const partner = code.startsWith('INTERNATIONAL_');
  for (const pattern of DEPOT_PLACES) {
    const depot = place(pattern);
    if (depot && partner) return country ? `${depot}, ${country}` : depot;
    if (depot) return `${depot}, Germany`;
  }
  if (country) return country;
  const town = code.startsWith('PARCELSHOP_') ? place(SHOP_TOWN) : '';
  return town ? `${town}, Germany` : null;
}

/**
 * The partner abroad Hermes handed the parcel to and its number there, from the
 * link the tracking page shows as the international delivery partner. Both stand
 * when the catalog's link rules read them from it, on a host of that carrier's
 * own links. The link is never followed.
 */
function internationalPartner(view: Record<string, unknown>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const link = clean(view.internationalTrackingLink, 2_000);
  let host: string;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return {}; }
  const match = parseTrackingInput(link);
  if (match.source !== 'link' || match.confidence !== 'high' || match.carrier === 'unknown' || match.carrier === 'hermes-de'
    || !carrierLinkRules(match.carrier).some((rule) => rule.domains.some((domain) => matchesDomain(host, domain)))) return {};
  const number = normalizeTrackingNumber(match.trackingNumber).toUpperCase();
  return /^[A-Z0-9]{4,40}$/.test(number) ? { delivery_carrier: match.carrier, delivery_tracking_number: number } : {};
}

/**
 * A 14-digit number failing the barcode check digit is no Hermes barcode but a
 * reference, which the search resolves to its parcel as the tracking page does.
 * With `references`, that one parcel answers and names its own barcode. A
 * barcode asked with a leading zero too many is answered under the barcode
 * itself, the parcel's own number, so recognition takes it as tracking does.
 */
export function parseHermesGermanyResponse(payload: unknown, trackingNumber: string, { references = false } = {}): CarrierResult {
  const requested = normalizeHermesGermanyNumber(trackingNumber);
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking response');
  }
  if (!payload.length) throw new HermesGermanyTrackingError();
  const parcels = payload.filter((entry) => entry.barcode === requested);
  const barcode = payload.length === 1 && typeof payload[0]!.barcode === 'string' ? payload[0]!.barcode : '';
  const padded = /^0\d{14}$/.test(requested) && barcode === requested.slice(1) && isValidHermesParcelNumber(barcode);
  const reference = !parcels.length && (padded || references && /^\d{14}$/.test(requested)
    && !isValidHermesParcelNumber(requested) && /^(?=.*\d)[A-Z0-9]{8,20}$/.test(barcode));
  if (reference) parcels.push(payload[0]!);
  if (parcels.length !== 1) throw new SchemaError(CARRIER, 'Hermes Germany returned a different or ambiguous shipment');
  const progress = parcels[0]!.parcelProgress;
  if (!Array.isArray(progress) || !progress.length || progress.length > 500) {
    throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking history');
  }
  const seen = new Set<string>();
  const events: Array<{ event: CarrierEvent; timestamp: number; metadata?: Milestone }> = [];
  for (const entry of progress) {
    if (!isRecord(entry) || typeof entry.timestamp !== 'string'
      || typeof entry.parcelStatus !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.parcelStatus)) {
      throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking event');
    }
    const date = firstOccurrence(DateTime.fromISO(entry.timestamp, { zone: 'Europe/Berlin', setZone: true }));
    if (!date.isValid) throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid event date');
    const time = date.toUTC().toISO();
    const identity = `${time}|${entry.parcelStatus}`;
    if (seen.has(identity) || IGNORED_BOOKING_STATUS.has(entry.parcelStatus)) continue;
    seen.add(identity);
    const metadata = hermesGermanyMilestone(entry.parcelStatus);
    // historyText is the carrier's display wording; the `status` field only
    // carries generic HAPPY/FINISHED buckets and is never display text.
    const rawText = clean(entry.historyText);
    const location = wordedPlace(rawText, entry.parcelStatus);
    events.push({
      timestamp: date.toMillis(),
      metadata,
      event: {
        time,
        description: rawText || metadata?.description || 'Hermes tracking update',
        ...(location ? { location } : {}),
        // An unmapped code is left to the shared wording classifier.
        ...(metadata ? { stage: metadata.stage } : {}),
        provider_code: entry.parcelStatus,
      },
    });
  }
  if (listsNewestFirst(events.map(({ event }) => event)) === false) events.reverse();
  events.sort((a, b) => b.timestamp - a.timestamp);
  let uncollected = false;
  for (const entry of [...events].reverse()) {
    if (entry.event.provider_code === NOT_COLLECTED_ABROAD) uncollected = true;
    else if (uncollected && entry.event.provider_code === DELIVERED_ABROAD) {
      entry.metadata = RETURN_HANDOVER;
      entry.event.stage = RETURN_HANDOVER.stage;
    }
  }
  const latest = events[0];
  if (!latest) throw new HermesGermanyTrackingError();
  const parcel = parcels[0] as Record<string, unknown>;
  const attributes = isRecord(parcel.parcelAttributes) ? parcel.parcelAttributes : {};
  const atg = isRecord(parcel.atg) ? parcel.atg : {};
  const sender = clean(atg.companyName) || null;
  const eta = etaDate(parcel.eta ?? parcel.deliveryForecast ?? attributes.deliveredTimestamp);
  // The tracking page offers the Hermes Box pickup code while
  // `readyForParcelBoxCollection` is true: the parcel waits in the locker,
  // even when the newest row or the delivered flag reads as a delivery.
  // Once Hermes clears it, a box delivery that is still the newest row has
  // been taken out.
  const view = isRecord(parcel.viewParameters) ? parcel.viewParameters : {};
  const partner = internationalPartner(view);
  const boxReady = view.readyForParcelBoxCollection;
  const latestCode = latest.event.provider_code;
  const readsDelivered = !latest.metadata || latest.metadata.stage === 'delivered';
  const inBox = latestCode === IN_PARCELBOX ? boxReady !== false : boxReady === true && readsDelivered;
  const takenOut = latestCode === IN_PARCELBOX && boxReady === false;
  if (inBox) {
    latest.metadata = hermesGermanyMilestone(IN_PARCELBOX);
    latest.event.stage = 'ready_for_pickup';
  }
  const deliveredByCode = latest.metadata?.status === 'delivered' || takenOut;
  // The flag stands in for a delivery code not mapped yet; a mapped row that says
  // otherwise, as a return handed back to the sender, keeps its own stage.
  const deliveredByFlag = attributes.delivered === true && readsDelivered;
  const delivered = !inBox && (deliveredByCode || deliveredByFlag);
  if (!latest.metadata && !delivered) {
    return {
      status: 'unknown',
      last_status_text: latest.event.description,
      last_update: latest.event.time,
      expected_delivery: null,
      timezone: 'Europe/Berlin',
      ...(sender ? { sender_name: sender } : {}),
      ...(reference ? { canonical_tracking_number: barcode } : {}),
      ...partner,
      events: events.slice(0, 100).map(({ event }) => event),
    };
  }
  const status = delivered ? 'delivered' as const : latest.metadata!.status;
  const stage = takenOut ? 'delivered' : latest.metadata?.stage ?? (delivered ? 'delivered' : 'in_transit');
  const deliveredAt = delivered ? latest.event.time : null;
  const pickupPoint = parcelShop(parcel, latest);
  return {
    status,
    current_stage: stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time,
    expected_delivery: delivered ? null : eta,
    timezone: 'Europe/Berlin',
    ...(sender ? { sender_name: sender } : {}),
    ...(deliveredAt && status === 'delivered' ? { delivered_at: deliveredAt } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(reference ? { canonical_tracking_number: barcode } : {}),
    ...partner,
    events: events.slice(0, 100).map(({ event }) => event),
  };
}

export class HermesGermanyTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | HermesGermanyOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, fetcher: undefined, userAgent: undefined }
      : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Hermes Germany timeout must be positive');
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  /**
   * `references` takes a reference's parcel; recognition, which claims the number, asks for the barcode itself.
   * `language` words the scans: German, or English as the page's English route asks.
   */
  async fetch(trackingNumber: string, context: TrackingContext = {}, references = false, language: 'de' | 'en' = 'en'): Promise<CarrierResult> {
    const number = normalizeHermesGermanyNumber(trackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { response, bytes } = await fetchBounded(`${API}${encodeURIComponent(number)}`, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'X-Language': language,
        Referer: 'https://www.myhermes.de/',
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: PROVIDER,
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: 750_000,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    if (response.status === 404) throw new HermesGermanyTrackingError();
    if (!response.ok) throw new UpstreamHttpError(PROVIDER, response.status);
    return parseHermesGermanyResponse(parseJsonBytes(bytes, PROVIDER), number, { references });
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HermesGermanyTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'hermes-de',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context, true, readerLanguage(input, ['de']) ?? 'en'),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context)),
  };
};
