
import { DateTime } from 'luxon';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { amazonShippingOrigin, amazonShippingUrl } from '../../core/catalog/index.js';
import { isAmazonTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { cleanScalar, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyStatus, DELAYED, statusKey, type ClassifiedStatus } from './status.js';

const PROVIDER = 'Amazon Shipping';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
// Amazon's robot check, which can stand in for the tracker's reply.
const CAPTCHA = /\/errors\/validateCaptcha|opfcaptcha|api-services-support@amazon\.com/i;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

export { amazonShippingStatus } from './status.js';

interface ParsedDate {
  iso: string;
  timestamp: number;
}

interface ParsedEvent {
  event: CarrierEvent;
  classified: ClassifiedStatus;
  timestamp: number;
  /** A facility departure, by its event code or string id. */
  departure: boolean;
}

const VAN_DEPARTURE: ClassifiedStatus = { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' };

export interface AmazonShippingOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

/** A confirmed absence, with a public reason consumers can inspect. */
export class AmazonShippingNotFoundError extends NotFoundError {
  constructor() {
    super(PROVIDER, undefined, { reason: 'shipment_not_found' });
    this.name = 'AmazonShippingNotFoundError';
  }
}

/**
 * Amazon recognizes the shipment but will not serve its history any more.
 * A definite answer that still yields no usable tracking data, so it maps to
 * the taxonomy's `indeterminate` kind. The host narrows on this class with
 * `instanceof` to store the history-expired marker and stop scheduling syncs.
 */
export class AmazonShippingHistoryExpiredError extends IndeterminateError {
  constructor() {
    super(PROVIDER, 'Amazon Shipping tracking history has expired', { reason: 'history_expired' });
    this.name = 'AmazonShippingHistoryExpiredError';
  }
}

function eventKey(raw: JsonObject): string {
  const summary = isRecord(raw.statusSummary) ? raw.statusSummary : {};
  return [summary.localisedStringId, raw.eventCode, raw.subReasonCode]
    .map(statusKey)
    .join(' ');
}

function eventDescription(key: string, classified: ClassifiedStatus): string {
  if (key.includes('creationconfirmed')) return 'Shipment information received';
  if (key.includes('pickupdone') || key.includes('detailpickedup')) return 'Shipment picked up';
  // Out-for-delivery scans carry the string id of the delivery centre's arrival; the code decides.
  if (classified.stage !== 'in_transit') return classified.description;
  // Amazon reads the final hub as "the final hub/delivery station".
  if (key.includes('arrivedatdeliverycenter') || key.includes('arrivedatfinalhub')) return 'Arrived at delivery center';
  if (key.includes('arrivedatsortcenter')) return 'Arrived at sorting center';
  if (key.includes('departed')) return 'Departed facility';
  return classified.description;
}

/**
 * Clock policy, deliberately not one of `core/time`'s helpers: the tracker
 * mixes ISO-8601, RFC 2822 and US long-form dates. A value without an offset
 * is UTC on every host: the tracker promises US deliveries for 3 AM, the
 * evening before in every US zone.
 */
function parseDate(value: unknown): ParsedDate | null {
  const raw = cleanScalar(value, 100);
  if (!raw) return null;
  const candidates = [
    DateTime.fromISO(raw, { setZone: true, zone: 'UTC' }),
    DateTime.fromRFC2822(raw, { setZone: true }),
    ...[
      'LLL d, yyyy, h:mm:ss a',
      'LLL d, yyyy, h:mm a',
      'LLLL d, yyyy, h:mm:ss a',
      'LLLL d, yyyy, h:mm a',
    ].map((format) => DateTime.fromFormat(raw, format, { locale: 'en-US', zone: 'UTC' })),
  ];
  const parsed = candidates.find((candidate) => candidate.isValid);
  if (!parsed) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function parseSerializedRecord(value: unknown, field: string): JsonObject {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new SchemaError(PROVIDER, `Amazon Shipping returned an invalid ${field}`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    throw new SchemaError(PROVIDER, `Amazon Shipping returned an invalid ${field}`, { cause: error });
  }
  throw new SchemaError(PROVIDER, `Amazon Shipping returned an invalid ${field}`);
}

function optionalSerializedRecord(value: unknown, field: string): JsonObject | null {
  if (value == null || value === 'null' || value === '') return null;
  return parseSerializedRecord(value, field);
}

function isNotFoundError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const key = `${statusKey(value.errorCode)} ${statusKey(value.errorMessage)}`;
  // An Amazon retail order: the public tracker knows it but only the buyer's account may read it.
  return key.includes('trackingidnotfound') || key.includes('invalidtrackingid') || key.includes('invalidoffamazonorder');
}

/**
 * City, region and country only; the same object also carries the street and postcode.
 * A region Amazon does not know reads "N/A".
 */
function location(raw: unknown): string {
  if (!isRecord(raw)) return '';
  const values = [raw.city, raw.stateProvince, raw.countryCode]
    .map((value) => cleanScalar(value, 100))
    .filter((value, index, all) => value && !/^n\/a$/i.test(value)
      && all.findIndex((candidate) => candidate.toLocaleLowerCase('en-US')
        === value.toLocaleLowerCase('en-US')) === index);
  return values.join(', ').slice(0, 250);
}

function providerCode(value: unknown): string {
  const code = cleanScalar(value, 64);
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : '';
}

function eventRecords(value: JsonObject | null): JsonObject[] {
  const events = value?.eventHistory;
  return Array.isArray(events) ? events.filter(isRecord) : [];
}

function parseEvent(raw: JsonObject): ParsedEvent | null {
  const summary = isRecord(raw.statusSummary) ? raw.statusSummary : {};
  const classified = classifyStatus(
    summary.localisedStringId,
    raw.eventCode,
    raw.subReasonCode,
  );
  const time = parseDate(raw.eventTime);
  const clockText = time ? '' : cleanScalar(raw.eventTime, 100);
  const code = providerCode(raw.eventCode);
  if (!time && !code && classified.status === 'unknown') return null;
  const eventLocation = location(raw.location);
  const key = eventKey(raw);
  return {
    classified,
    timestamp: time?.timestamp ?? Number.NEGATIVE_INFINITY,
    departure: classified.stage === 'in_transit' && key.includes('departed'),
    event: {
      ...(time ? { time: time.iso } : clockText ? { provider_time_text: clockText } : {}),
      ...(eventLocation ? { location: eventLocation } : {}),
      description: eventDescription(key, classified),
      stage: classified.stage,
      ...(code ? { provider_code: code } : {}),
    },
  };
}

/** How soon after the out-for-delivery scan a departure from its station is the van leaving. */
const VAN_DEPARTURE_MS = 3_600_000;

/** Milliseconds from one scan to the next, or NaN. */
function scanGapMs(from: CarrierEvent, to: CarrierEvent): number {
  return from.time && to.time ? Date.parse(to.time) - Date.parse(from.time) : Number.NaN;
}

/**
 * A departure scanned right after the out-for-delivery scan, within the hour
 * and at the same station, is the van leaving with the parcel: still out for
 * delivery. Read as a facility departure it would step the newest scan back to
 * in transit. `events` is newest first.
 */
function restageVanDepartures(events: ParsedEvent[]): void {
  for (let index = events.length - 2; index >= 0; index--) {
    const item = events[index]!;
    const previous = events[index + 1]!;
    const gap = scanGapMs(previous.event, item.event);
    if (item.departure && previous.classified.stage === 'out_for_delivery' && previous.classified !== VAN_DEPARTURE
      && item.event.location && item.event.location === previous.event.location && gap >= 0 && gap <= VAN_DEPARTURE_MS) {
      item.classified = VAN_DEPARTURE;
      item.event.stage = VAN_DEPARTURE.stage;
    }
  }
}

function metadataValue(metadata: JsonObject, field: string): unknown {
  const value = metadata[field];
  if (!isRecord(value)) return value;
  return value.stringValue ?? value.date ?? value.value;
}

export function normalizeAmazonShippingTrackingNumber(raw: string): string {
  const value = raw.trim().toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!isAmazonTrackingNumber(value)) {
    throw new InvalidInputError(PROVIDER, 'Amazon tracking numbers need a European country prefix and 10 digits, or TBA, TBC or TBM and 12 digits');
  }
  return value;
}

export function amazonShippingTrackingUrl(rawTrackingNumber: string): string {
  const trackingNumber = normalizeAmazonShippingTrackingNumber(rawTrackingNumber);
  return amazonShippingUrl(trackingNumber);
}

export function amazonShippingTrackingApiUrl(rawTrackingNumber: string): string {
  const trackingNumber = normalizeAmazonShippingTrackingNumber(rawTrackingNumber);
  return `${amazonShippingOrigin(trackingNumber)}/api/tracker/${encodeURIComponent(trackingNumber)}`;
}

export function parseAmazonShippingTrackingResponse(payload: unknown, zone: string | null = 'Europe/Paris', trackingNumber?: string): CarrierResult {
  if (!isRecord(payload)) {
    throw new SchemaError(PROVIDER, 'Amazon Shipping returned an invalid tracking response');
  }
  const progress = parseSerializedRecord(payload.progressTracker, 'progress tracker');
  const errors = Array.isArray(progress.errors) ? progress.errors : [];
  if (errors.some(isNotFoundError)) throw new AmazonShippingNotFoundError();

  // The endpoint is shipment-scoped but does not normally echo identity. Reject a
  // contradictory ID when supplied; never accept a generic page or status alone.
  const identitySummary = isRecord(progress.summary) ? progress.summary : {};
  const identityMetadata = isRecord(identitySummary.metadata) ? identitySummary.metadata : {};
  for (const identity of [payload.trackingId, payload.trackingID, progress.trackingId, metadataValue(identityMetadata, 'trackingId')]) {
    if (trackingNumber && identity != null && (typeof identity !== 'string' || identity.toUpperCase() !== trackingNumber)) {
      throw new SchemaError(PROVIDER, 'Amazon Shipping returned a different tracking number');
    }
  }
  if (!['SWA', 'MCF'].includes(String(progress.trackerSource))) throw new AmazonShippingNotFoundError();
  if (errors.length && errors.every((error) => isRecord(error) && error.errorCode === 'SHIPMENT_OLDER_THAN_SUPPORTED_AGE')) {
    throw new AmazonShippingHistoryExpiredError();
  }
  if (errors.length) throw new SchemaError(PROVIDER, 'Amazon Shipping returned tracking errors');
  const history = optionalSerializedRecord(payload.eventHistory, 'event history');
  const seen = new Set<string>();
  const parsedEvents: ParsedEvent[] = [];
  eventRecords(history).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw) => {
    const parsed = parseEvent(raw);
    if (!parsed) return;
    const identity = JSON.stringify([
      parsed.event.time ?? parsed.event.provider_time_text ?? '',
      parsed.event.location ?? '',
      parsed.event.provider_code ?? '',
      parsed.event.description ?? '',
    ]);
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push(parsed);
  });
  if (listsNewestFirst(parsedEvents.map(({ event }) => event)) === false) parsedEvents.reverse();
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp);
  restageVanDepartures(parsedEvents);
  const events = parsedEvents.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);

  const summary = isRecord(progress.summary) ? progress.summary : {};
  const metadata = isRecord(summary.metadata) ? summary.metadata : {};
  const tags = Array.isArray(summary.containerStatusTags)
    ? summary.containerStatusTags.join(' ')
    : '';
  const trackingStatus = metadataValue(metadata, 'trackingStatus');
  const current = classifyStatus(trackingStatus, summary.status, tags);
  const latestKnown = parsedEvents.find((item) => item.classified.status !== 'unknown');
  // A summary whose only signal repeats the newest scan's event code says less
  // than that scan, which is also read by its string id and the scan before it.
  const newestCode = parsedEvents[0]?.event.provider_code;
  const echoesNewest = !statusKey(trackingStatus) && !tags && newestCode !== undefined
    && statusKey(summary.status) === statusKey(newestCode);
  // A summary saying delivered when no scan does is not taken: the tracker said so of parcels
  // that had just left their pickup site and went on being scanned for another day.
  const unscannedDelivery = current.stage === 'delivered' && latestKnown !== undefined
    && !parsedEvents.some((item) => item.classified.stage === 'delivered');
  // A delay moves nothing: a parcel whose scans show only its label keeps that stage, with the delay as its text.
  const unmovedDelay = current === DELAYED && latestKnown?.classified.stage === 'registered';
  const active = unmovedDelay ? { ...latestKnown.classified, description: DELAYED.description }
    : current.status !== 'unknown' && !echoesNewest && !unscannedDelivery ? current : latestKnown?.classified;
  if (!active) {
    throw new SchemaError(PROVIDER, 'Amazon Shipping returned incomplete tracking details');
  }

  const fallbackUpdate = [
    'deliveryDate',
    'pickupEventDate',
    'creationDate',
  ].map((field) => parseDate(metadataValue(metadata, field))).find(Boolean) ?? null;
  const expected = parseDate(
    progress.expectedDeliveryDate
      ?? metadataValue(metadata, 'expectedDeliveryDate')
      ?? metadataValue(metadata, 'promisedDeliveryDate'),
  );
  const delivered = active.stage === 'delivered';
  const delivery = delivered
    ? parsedEvents.find((item) => item.classified.stage === 'delivered' && item.event.time)?.event.time
    : undefined;
  return {
    status: active.status,
    current_stage: active.stage,
    last_status_text: active.description,
    last_update: events[0]?.time ?? fallbackUpdate?.iso ?? null,
    // The promise's day is the recipient's, which a US number does not place.
    expected_delivery: delivered || !expected || !zone ? null : DateTime.fromMillis(expected.timestamp, { zone }).toISODate(),
    ...(delivery ? { delivered_at: delivery } : {}),
    ...(zone ? { timezone: zone } : {}),
    events,
  };
}

export function amazonShippingTimezone(number: string): string | null {
  if (number.startsWith('TB')) return null; // A North American number cannot establish a local timezone.
  const zones: Record<string, string> = {
    UK: 'Europe/London', GB: 'Europe/London', IE: 'Europe/Dublin', PT: 'Europe/Lisbon',
    FI: 'Europe/Helsinki', EE: 'Europe/Tallinn', LV: 'Europe/Riga', LT: 'Europe/Vilnius',
    GR: 'Europe/Athens', CY: 'Asia/Nicosia', RO: 'Europe/Bucharest', BG: 'Europe/Sofia',
    IS: 'Atlantic/Reykjavik', TR: 'Europe/Istanbul',
  };
  return zones[number.slice(0, 2)] ?? 'Europe/Paris';
}

export class AmazonShippingTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | AmazonShippingOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, fetcher: undefined, userAgent: undefined }
      : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Amazon Shipping timeout must be positive');
    }
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeAmazonShippingTrackingNumber(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { bytes } = await fetchBounded(amazonShippingTrackingApiUrl(trackingNumber), {
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: amazonShippingTrackingUrl(trackingNumber),
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: 'Amazon Shipping tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    const head = decodeText(bytes.subarray(0, 64_000));
    if (/^\s*</.test(head)) {
      if (CAPTCHA.test(head)) throw new ChallengeError(PROVIDER, 'Amazon Shipping asked for a captcha');
      throw new IndeterminateError(PROVIDER, 'Amazon Shipping answered with its tracking page instead of tracking data');
    }
    let payload: unknown;
    try {
      payload = parseJsonBytes(bytes, PROVIDER);
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'Amazon Shipping returned invalid tracking JSON', { cause });
    }
    return parseAmazonShippingTrackingResponse(payload, amazonShippingTimezone(trackingNumber), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AmazonShippingTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'amazon-shipping',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
