/**
 * GLS France: the public consignee endpoint called by moncolis.gls-france.com.
 *
 * One bounded GET per lookup ('direct' step). The response carries the parcel
 * record, its event list, and blocks describing the people involved; `parse()`
 * builds its result from an explicit allowlist of status, timing, sender and
 * operational-location fields, so recipient names, street addresses, contacts,
 * signatures and delivery instructions never leave this module. While the parcel
 * waits at a shop, a locker or its depot, a second GET reads that place's record,
 * as the tracking page does, for its name and address.
 */

import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { isValidGlsParcelNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { EXPLICIT_OFFSET_PATTERN, firstOccurrence, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  FAILED_DELAYED_DELIVERY,
  glsFranceStatusCode,
  glsFranceStatusMetadata,
  type GLSFranceStatusMetadata,
} from './status.js';

export { glsFranceStatus } from './status.js';

const PROVIDER = 'GLS France';
const TRACKING_API =
  'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes';
const NODE_API = 'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v2/searchNode';
const AGENCY_API = 'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/agency';
const TRACKING_PAGE = 'https://moncolis.gls-france.com/fr';
const TIMEZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 750_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
/** The pickup point is optional: its request gets a short bound and never the parcel's whole budget. */
const PICKUP_TIMEOUT_MS = 4_000;
const MAX_NODE_BYTES = 100_000;
/** Shops and lockers. A neighbour who keeps parcels for GLS is a private person and is never read. */
const PICKUP_POINT_TYPES = new Set(['PARCEL_SHOP', 'LOCKER']);
const NEIGHBOUR_NETWORK = '2501';
/** Waiting at a shop or locker. */
const WAITING_AT_POINT = new Set(['LIP', 'LTP', 'LIK', 'LTK']);
/** Waiting at the depot, where the recipient collects it. */
const WAITING_AT_DEPOT = 'PAQ';

function locationCode(value: unknown): string {
  const code = cleanScalar(value, 16).toLocaleUpperCase('en-US');
  return /^[A-Z]{2}[A-Z0-9]{2,8}$/.test(code) ? code : '';
}

/**
 * GLS France puts three shapes on the same timestamp fields: an ISO value with
 * or without an offset, a SQL-style `YYYY-MM-DD HH:mm:ss.S` wall clock, and a
 * bare calendar day. No single `core/time` policy covers all three, so this
 * helper stays local: an explicit offset is honored, everything else is read in
 * Europe/Paris, which is the zone the French backend stamps.
 */
function parsedTime(value: unknown): ParsedTime | null {
  const raw = cleanScalar(value, 64);
  // Empty timestamps arrive padded with year 1 instead of being omitted.
  if (!raw || raw.startsWith('0001-')) return null;
  let parsed = raw.includes('T')
    ? firstOccurrence(DateTime.fromISO(raw, { setZone: EXPLICIT_OFFSET_PATTERN.test(raw), zone: TIMEZONE }))
    : firstOccurrence(DateTime.fromSQL(raw, { zone: TIMEZONE }));
  if (!parsed.isValid && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsed = firstOccurrence(DateTime.fromISO(raw, { zone: TIMEZONE }));
  }
  if (!parsed.isValid) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function expectedDelivery(value: unknown): string | null {
  return parsedTime(value)?.iso.slice(0, 10) ?? null;
}

/**
 * A GLS parcel number is 11 digits; labels print it with its check digit as a
 * 12th. A 12-digit number is accepted only when that digit is valid, and is
 * known by its first 11 digits.
 */
function parcelNumber(value: string): string {
  if (/^(?:[A-Z0-9]{8}|\d{11})$/.test(value)) return value;
  return isValidGlsParcelNumber(value) ? value.slice(0, 11) : '';
}

function normalizedCandidate(value: unknown): string {
  return parcelNumber(cleanScalar(value, 32).toLocaleUpperCase('en-US').replace(/[\s.-]/g, ''));
}

function printedNumber(raw: string): string {
  return raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
}

export function normalizeGLSFranceTrackingNumber(raw: string): string {
  const value = parcelNumber(printedNumber(raw));
  if (!value) {
    throw new InvalidInputError(PROVIDER, 'GLS France tracking numbers must contain 8 letters or digits, or 11 digits (12 with a valid check digit)');
  }
  return value;
}

export function glsFranceTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

export function glsFranceTrackingApiUrl(trackingNumber: string): string {
  return `${TRACKING_API}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function responseIdentifiers(parcel: JsonObject): string[] {
  return [parcel.trackid, parcel.numeroalphaColis, parcel.numeroGp]
    .map(normalizedCandidate)
    .filter(Boolean);
}

interface ParsedEvent {
  event: CarrierEvent;
  timestamp: number;
  typeCode: string;
  metadata: GLSFranceStatusMetadata | null;
}

function parseEvent(raw: JsonObject): ParsedEvent | null {
  const eventStatusCode = glsFranceStatusCode(raw.statutEvenement);
  const typeCode = glsFranceStatusCode(raw.typeEvenement);
  const code = eventStatusCode || typeCode;
  const metadata = eventStatusCode === 'DEL' && typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : glsFranceStatusMetadata(code);
  const time = parsedTime(raw.datereference) ?? parsedTime(raw.datecreation);
  if (!code && !time) return null;
  const location = locationCode(raw.codelieuEvenement);
  return {
    timestamp: time?.timestamp ?? Number.NEGATIVE_INFINITY,
    typeCode,
    metadata,
    event: {
      ...(time ? { time: time.iso } : {}),
      ...(location ? { location } : {}),
      description: metadata?.description ?? 'GLS France tracking update',
      // An unmapped code carries no stage: the sync classifies and records it.
      ...(metadata ? { stage: metadata.stage } : {}),
      ...(code ? { provider_code: code } : {}),
    },
  };
}

/**
 * The shop or locker holding the parcel, from its own record, while its status says it waits
 * there. Not under action 20, collection at the depot, for which the tracking page asks for the
 * depot instead. A neighbour's id is never asked for.
 */
function waitingPoint(parcel: JsonObject, code: string): string {
  if (!WAITING_AT_POINT.has(code) || cleanScalar(parcel.codeActionColis, 8) === '20') return '';
  const point = cleanScalar(parcel.relaisGlsColis, 20);
  return /^\d{6,15}$/.test(point) && !/^0+$/.test(point) && !point.startsWith(NEIGHBOUR_NETWORK) ? point : '';
}

/**
 * The depot holding the parcel, while its status says it waits there for collection: the parcel's
 * theoretical delivery place, the six-character code the tracking page asks the agency endpoint for.
 */
function waitingDepot(parcel: JsonObject, code: string): string {
  if (code !== WAITING_AT_DEPOT) return '';
  const depot = cleanScalar(parcel.lieuTheoriqueLivraison, 8).toLocaleUpperCase('en-US');
  return /^[A-Z]{2}[A-Z0-9]{4}$/.test(depot) ? depot : '';
}

/**
 * The point's record, if it is the requested shop or locker: its name, then its street and its
 * postcode and town on their own lines, as the tracking page prints them. A record without a street
 * or town keeps the name alone. Its opening hours and coordinates are not read.
 */
export function glsFrancePickupPoint(node: unknown, point: string): string {
  if (!isRecord(node) || cleanScalar(node.parcelShopId, 20) !== point) return '';
  if (!PICKUP_POINT_TYPES.has(cleanScalar(node.parcelShopType, 20)) || cleanScalar(node.type, 20) === 'KEEPER') return '';
  const name = clean(node.name, 120);
  if (!name) return '';
  const address = isRecord(node.address) ? node.address : {};
  const street = clean(address.street, 120);
  const town = clean(address.city, 80);
  if (!street || !town) return name;
  return pointLines(name, [street], cleanScalar(address.zipCode, 10), town);
}

/**
 * The depot's record, if it is the requested depot: its name, then its address lines and its
 * postcode and town on their own lines, as the tracking page prints them. A record without a street
 * or town keeps the name alone. Its phone, opening hours and coordinates are not read.
 */
export function glsFranceDepot(record: unknown, depot: string): string {
  if (!isRecord(record) || cleanScalar(record.codeLieu, 16).toLocaleUpperCase('en-US') !== depot) return '';
  const name = clean(record.libelleLieu, 120);
  if (!name) return '';
  const street = [record.libelleAdresse1Lieu, record.libelleAdresse2Lieu, record.libelleAdresse3Lieu]
    .map((line) => clean(line, 120))
    .filter(Boolean);
  const town = clean(record.villeLieu, 80);
  if (street.length === 0 || !town) return name;
  return pointLines(name, street, cleanScalar(record.codepostalLieu, 10), town);
}

function pointLines(name: string, street: string[], postcode: string, town: string): string {
  return [name, ...street, [/^\d{5}$/.test(postcode) ? postcode : '', town].filter(Boolean).join(' ')].join('\n');
}

interface ParsedTracking {
  result: CarrierResult;
  /** The parcel's own code, which the tracking page names in the point's request. */
  code: string;
  /** The shop or locker holding the parcel, else empty. */
  point: string;
  /** The depot holding the parcel for collection, else empty. */
  depot: string;
}

export function parseGLSFranceTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  return parseTracking(payload, trackingNumber).result;
}

function parseTracking(payload: unknown, trackingNumber: string): ParsedTracking {
  const requested = normalizeGLSFranceTrackingNumber(trackingNumber);
  if (!isRecord(payload) || !isRecord(payload.colis)) {
    throw new SchemaError(PROVIDER, 'GLS France returned an invalid tracking response');
  }

  const parcel = payload.colis;
  const identifiers = responseIdentifiers(parcel);
  if (identifiers.length === 0) {
    throw new SchemaError(PROVIDER, 'GLS France did not return a shipment identifier');
  }
  if (!identifiers.includes(requested)) {
    throw new SchemaError(PROVIDER, 'GLS France returned a different shipment');
  }

  const seen = new Set<string>();
  const parsedEvents: ParsedEvent[] = [];
  records(payload.evenements).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw) => {
    const parsed = parseEvent(raw);
    if (!parsed) return;
    const identity = JSON.stringify([
      parsed.event.time ?? '',
      parsed.event.location ?? '',
      parsed.event.provider_code ?? '',
    ]);
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push(parsed);
  });
  if (listsNewestFirst(parsedEvents.map(({ event }) => event)) === false) parsedEvents.reverse();
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp);
  // Oldest first: a depot receives the parcel on its way in and again when a
  // round brings it back, so a receipt after the parcel moved on is in transit.
  let moved = false;
  for (const { event } of [...parsedEvents].reverse()) {
    if (event.stage === 'accepted' && moved) event.stage = 'in_transit';
    if (event.stage && event.stage !== 'registered' && event.stage !== 'accepted') moved = true;
  }
  const latestParsedEvent = parsedEvents[0];
  const events = parsedEvents
    .slice(0, MAX_EVENTS_TO_RETURN)
    .map(({ event }) => event);

  const currentCode = glsFranceStatusCode(parcel.statutColis);
  const current = currentCode === 'DEL' && latestParsedEvent?.typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : glsFranceStatusMetadata(currentCode);
  const latestEvent = events[0];
  const latestEventStatus = latestParsedEvent?.metadata ?? glsFranceStatusMetadata(latestEvent?.provider_code);
  const fallbackUpdate = parsedTime(parcel.dateActionColis);
  const status = current?.status ?? latestEventStatus?.status ?? 'unknown';
  const stage = current?.stage ?? latestEventStatus?.stage;
  // The code the stage comes from: the parcel's own, else its newest event's.
  const stageCode = current ? currentCode : latestEvent?.provider_code ?? '';
  // Delivered, waiting at a shop or in trouble, the portal shows the scan's
  // own day instead of the theoretical one, which is then stale.
  const settled = status === 'delivered' || status === 'exception' || stage === 'ready_for_pickup';
  // The portal shows this label as the sender.
  const sender = clean(parcel.libelleExpediteur, 200);
  const deliveredAt = status === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    result: {
      status,
      last_status_text: current?.description
        ?? latestEvent?.description
        ?? 'Tracking information received',
      last_update: latestEvent?.time ?? fallbackUpdate?.iso ?? null,
      expected_delivery: settled ? null : expectedDelivery(parcel.dateTheoriqueLivraison),
      ...(sender ? { sender_name: sender } : {}),
      ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
      timezone: TIMEZONE,
      events,
    },
    code: normalizedCandidate(parcel.trackid) || requested,
    point: waitingPoint(parcel, stageCode),
    depot: waitingDepot(parcel, stageCode),
  };
}

export interface GLSFranceTrackerOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class GLSFranceTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: GLSFranceTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('GLS France timeout must be positive');
    }
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
  }

  /** Recognition only needs the parcel, so it can leave its pickup point unread. */
  async fetch(trackingNumber: string, context: TrackingContext = {}, { pickupPoint = true } = {}): Promise<CarrierResult> {
    const normalized = normalizeGLSFranceTrackingNumber(trackingNumber);
    const printed = printedNumber(trackingNumber);
    // Room for a request and its retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs);
    let parsed: ParsedTracking;
    try {
      parsed = await this.lookup(normalized, normalized, budget);
    } catch (error) {
      // The 11-digit parcel number is what GLS keys a parcel by. Should the
      // French backend only know the number as printed, ask for it once too.
      if (printed === normalized || !(error instanceof UpstreamHttpError) || error.status !== 404) throw error;
      parsed = await this.lookup(printed, normalized, budget);
    }
    const { result, code, point, depot } = parsed;
    let pickup = '';
    if (pickupPoint && point) {
      pickup = await this.pickupPoint(`${NODE_API}/${encodeURIComponent(code)}/${encodeURIComponent(point)}`,
        (record) => glsFrancePickupPoint(record, point), budget, context.signal);
    } else if (pickupPoint && depot) {
      pickup = await this.pickupPoint(`${AGENCY_API}/${encodeURIComponent(code)}/${encodeURIComponent(depot)}`,
        (record) => glsFranceDepot(record, depot), budget, context.signal);
    }
    return pickup ? { ...result, pickup_point: pickup } : result;
  }

  /** The pickup point, or nothing: the parcel is found without it. Only the caller's cancellation ends the lookup. */
  private async pickupPoint(
    url: string,
    read: (record: unknown) => string,
    budget: LookupBudget,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // Half of what is left at most, so the parcel itself is never late for its point.
    const timeoutMs = Math.min(PICKUP_TIMEOUT_MS, Math.floor(budget.remainingMs() / 2));
    if (timeoutMs < 100) return '';
    try {
      const { bytes } = await fetchBounded(url, {
        signal: budget.signal,
        headers: this.#headers(),
      }, {
        provider: 'GLS France pickup point',
        timeoutMs,
        maxBytes: MAX_NODE_BYTES,
        fetcher: this.#fetcher,
      });
      return read(parseJsonBytes(bytes, PROVIDER));
    } catch {
      signal?.throwIfAborted();
      return '';
    }
  }

  #headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Origin: 'https://moncolis.gls-france.com',
      Referer: `${TRACKING_PAGE}/`,
      'User-Agent': this.#userAgent,
    };
  }

  private async lookup(code: string, normalized: string, budget: LookupBudget): Promise<ParsedTracking> {
    // A request that fails to reach GLS, or hangs, is sent once more: the first
    // gets at most half of what is left, so the second fits in the rest.
    const { response, bytes } = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(`${TRACKING_API}/${encodeURIComponent(code)}`, {
      signal: budget.signal,
      headers: this.#headers(),
    }, {
      provider: 'GLS France tracking',
      timeoutMs: Math.min(this.timeoutMs, timeoutMs),
      maxBytes: MAX_RESPONSE_BYTES,
      fetcher: this.#fetcher,
      allowHttpStatuses: [404, 410],
    }));
    budget.signal.throwIfAborted();
    if ([404, 410].includes(response.status)) {
      // The native negative names the complete submitted code. An absent API
      // route or gateway response says nothing about the parcel.
      if (response.status === 404 && decodeText(bytes).trim() === `404 No command found for code: ${code}`) {
        throw new UpstreamHttpError('GLS France tracking', 404);
      }
      throw new TransportError(PROVIDER, 'GLS France tracking endpoint is unavailable', { status: response.status });
    }
    return parseTracking(parseJsonBytes(bytes, PROVIDER), normalized);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSFranceTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'gls-fr',
    // A departure can be entered at its planned time, such as the coming midnight.
    plannedScans: true,
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(
      () => tracker.fetch(number, context, { pickupPoint: false }),
      () => accepted(() => normalizeGLSFranceTrackingNumber(number)),
    ),
  };
};
