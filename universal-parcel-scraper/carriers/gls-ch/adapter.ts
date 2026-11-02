
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { lookupBudget, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { firstOccurrence } from '../../core/time/index.js';
import { cleanScalar, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyDescription, GLS_STATUSES, statusCode } from './status.js';

// Protocol provenance (inspected 2026-08-30):
// https://gls-group.eu/EU/en/parcel-tracking
// https://gls-group.eu/media/gls_group_resources/gls_group_witt002_js.js
// The current official frontend uses rstt029 for an anonymous overview, then
// rstt028/<parcel> with the recipient postcode for the detailed event history.
const TRACKING_PAGE = 'https://gls-group.eu/EU/en/parcel-tracking';
const TRACKING_API = 'https://gls-group.eu/app/service/open/rest/GROUP/en';
const PROVIDER = 'GLS Switzerland';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
/** GLS's `lastError` on a 404 overview: an expired parcel, and a number it does not know. */
export const GLS_OVERVIEW_NOT_FOUND: readonly string[] = ['E000', 'E206'];
/** And on a 404 detail, for an expired parcel. */
export const GLS_DETAIL_NOT_FOUND: readonly string[] = ['E000'];
/**
 * And on a 404 detail, for a postcode that does not match the parcel the overview found. GLS also
 * answers E609 to a malformed detail request (a missing owner code or `millis`, a wrong `caller`),
 * so the tests pin that request's shape.
 */
export const GLS_POSTCODE_MISMATCH: readonly string[] = ['E609', 'E800'];

/** GLS has the parcel, but not for the postcode given: the owner has to correct it. */
export function glsPostcodeMismatch(provider: string): InputRequiredError {
  return new InputRequiredError(provider, 'postcode', `${provider} has the parcel, but not for this postcode`, { reason: 'postcode_mismatch' });
}

/** GLS's own `lastError` code in a reply's body, or nothing when the body is not GLS's reply. */
export function glsLastError(bytes: Uint8Array): string {
  try {
    const payload = parseJsonBytes(bytes, PROVIDER);
    return isRecord(payload) && typeof payload.lastError === 'string' ? payload.lastError : '';
  } catch {
    return '';
  }
}

export { glsSwitzerlandStatus } from './status.js';

interface ParsedEvent {
  event: CarrierEvent;
  status: CarrierStatus;
  timestamp: number;
  sourceIndex: number;
}

export interface GLSSwitzerlandOptions {
  timeoutMs?: number;
  now?: () => number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

/** Kept as a named class: the German folder narrows on it with `instanceof`. */
export class GLSSwitzerlandTrackingError extends NotFoundError {
  constructor() {
    super(PROVIDER);
    this.name = 'GLSSwitzerlandTrackingError';
  }
}

function text(value: unknown, maxLength = 500): string {
  return cleanScalar(value, maxLength);
}

/** Provider strings can carry markup; render them to text before they are shown. */
function plainText(value: unknown, maxLength = 500): string {
  const raw = text(value, Math.max(maxLength * 10, 5_000));
  return raw ? text(load(raw).text(), maxLength) : '';
}

function isReturnParcel(parcel: JsonObject): boolean {
  // retourFlag marks an uncollected/returning parcel regardless of heading.
  for (const key of ['retourFlag', 'returnFlag', 'retour']) {
    const value = parcel[key];
    if (value === true || text(value, 8).toLocaleLowerCase('en-US') === 'true') return true;
  }
  return false;
}

export function normalizeGLSSwitzerlandTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?:(?=[A-Z0-9]{8}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]{8}|[A-Z]{6}|\d{11,14})$/.test(value)) {
    throw new InvalidInputError('GLS', 'GLS tracking requires a Track ID of 8 characters or 6 letters, or an 11-to-14-digit parcel number');
  }
  return value;
}

export type GLSPostcodeShape = 4 | 'any';

/**
 * The recipient postcode: four Swiss digits, or with `any` the postcode of any
 * country GLS delivers in. GLS refuses only what no country writes, such as a
 * symbol or fewer than three characters. With `any` only, a Swiss or
 * Liechtenstein postcode written with its country prefix is sent as its four
 * digits, which GLS matches.
 */
export function normalizeGLSSwitzerlandPostcode(raw: string, shape: GLSPostcodeShape = 4): string {
  const value = shape === 'any' ? deliveryPostcodeText(raw).replace(/^(?:CH|FL|LI)[- ]?(?=\d{4}$)/, '') : raw.trim();
  if (!(shape === 'any' ? DELIVERY_POSTCODE : /^\d{4}$/).test(value)) {
    const wanted = shape === 'any' ? 'recipient postcode' : '4-digit recipient postcode';
    throw new InputRequiredError('GLS', `the ${wanted}`, `GLS detailed tracking requires the ${wanted}`);
  }
  return value;
}

export function glsSwitzerlandTrackingUrl(rawTrackingNumber: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('match', normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber));
  return url.toString();
}

export function glsSwitzerlandOverviewApiUrl(
  rawTrackingNumber: string,
  millis = Date.now(),
): string {
  const url = new URL(`${TRACKING_API}/rstt029`);
  url.searchParams.set('match', normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber));
  url.searchParams.set('type', '');
  url.searchParams.set('caller', 'witt002');
  url.searchParams.set('millis', String(millis));
  return url.toString();
}

export function glsSwitzerlandDetailApiUrl(
  rawParcelNumber: string,
  rawPostcode: string,
  millis = Date.now(),
  ownerCode = '',
  postcodeShape: GLSPostcodeShape = 4,
): string {
  const parcelNumber = normalizeGLSSwitzerlandTrackingNumber(rawParcelNumber);
  if (!/^\d{11,14}$/.test(parcelNumber)) {
    throw new InputRequiredError('GLS', 'the numeric parcel number', 'GLS details require the numeric parcel number');
  }
  const url = new URL(`${TRACKING_API}/rstt028/${encodeURIComponent(parcelNumber)}`);
  url.searchParams.set('caller', 'witt002');
  url.searchParams.set('millis', String(millis));
  url.searchParams.set('postalCode', normalizeGLSSwitzerlandPostcode(rawPostcode, postcodeShape));
  const owner = text(ownerCode, 32);
  if (owner && /^[A-Z0-9_-]+$/i.test(owner)) url.searchParams.set('tuOwnerCode', owner);
  return url.toString();
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizedResponseIdentifier(value: unknown): string {
  try {
    return normalizeGLSSwitzerlandTrackingNumber(text(value, 32));
  } catch {
    return '';
  }
}

function referenceIdentifiers(parcel: JsonObject): string[] {
  return records(parcel.references)
    .filter((reference) => ['TRACKID', 'TRACK ID', 'PARCELNUMBER', 'TU'].includes(
      `${text(reference.type, 32)} ${text(reference.name, 32)}`.trim().toLocaleUpperCase('en-US'),
    ) || /track|parcel|paket/i.test(`${text(reference.type)} ${text(reference.name)}`))
    .map((reference) => normalizedResponseIdentifier(reference.value))
    .filter(Boolean);
}

function responseIdentifiers(parcel: JsonObject): string[] {
  return [
    normalizedResponseIdentifier(parcel.tuNo),
    normalizedResponseIdentifier(parcel.trackId),
    normalizedResponseIdentifier(parcel.trackingId),
    ...referenceIdentifiers(parcel),
  ].filter(Boolean);
}

function parcelRows(payload: unknown): JsonObject[] {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'GLS returned an invalid tracking response');
  if (Array.isArray(payload.tuStatus)) return records(payload.tuStatus);
  if (payload.tuNo) return [payload];
  throw new SchemaError(PROVIDER, 'GLS did not return tracking details');
}

export function selectGLSParcel(payload: unknown, rawTrackingNumber: string): JsonObject {
  const trackingNumber = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
  const parcels = parcelRows(payload);
  if (parcels.length === 0) throw new GLSSwitzerlandTrackingError();
  // GLS accepts an 11-digit parcel ID or its 12-digit printed form. Its
  // recipient API can return the first 11 digits for the latter (ShipIT docs:
  // https://gls-shipit.gls-group.eu/webservices/5_0_15/doxygen/WS-REST-API/rest_tracking.html).
  // Bind that alias to the exact prefix; never accept an unrelated numeric ID.
  const matching = parcels.filter((parcel) => responseIdentifiers(parcel).some((identifier) => (
    identifier === trackingNumber
    || (/^\d{12}$/.test(trackingNumber) && /^\d{11}$/.test(identifier)
      && trackingNumber.slice(0, 11) === identifier)
  )));
  if (matching.length === 1) return matching[0]!;
  // A Track ID, eight characters or the six letters of a notification card, is
  // translated by the overview endpoint to its numeric parcel number and is not
  // echoed. A single result is unambiguous.
  if (/^(?:[A-Z0-9]{8}|[A-Z]{6})$/.test(trackingNumber) && parcels.length === 1) return parcels[0]!;
  if (matching.length > 1) throw new SchemaError(PROVIDER, 'GLS returned an ambiguous shipment');
  throw new SchemaError(PROVIDER, 'GLS returned a different shipment');
}

/**
 * Local time policy: the service splits a scan into a `date` and a `time`
 * field, neither carrying an offset, in a list of formats that includes
 * `dd-MMM-yyyy`. They are wall-clock values at the scan facility and are read
 * in Europe/Zurich; the German folder relabels the result's timezone only.
 */
function parseEventTime(dateValue: unknown, timeValue: unknown): {
  iso: string;
  timestamp: number;
} | null {
  const date = text(dateValue, 64);
  const time = text(timeValue, 32);
  const joined = `${date} ${time}`.trim();
  if (!joined) return null;
  let parsed = firstOccurrence(DateTime.fromISO(joined, { zone: 'Europe/Zurich' }));
  if (!parsed.isValid) {
    for (const format of [
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd HH:mm',
      'dd-MMM-yyyy HH:mm:ss',
      'dd-MMM-yyyy HH:mm',
      'dd/MM/yyyy HH:mm',
      'dd.MM.yyyy HH:mm',
      'dd/MM/yyyy',
      'dd.MM.yyyy',
    ]) {
      parsed = firstOccurrence(DateTime.fromFormat(joined, format, { zone: 'Europe/Zurich', locale: 'en' }));
      if (parsed.isValid) break;
    }
  }
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return parsed.isValid && iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function eventLocation(raw: JsonObject): string {
  if (!isRecord(raw.address)) return '';
  // Retain coarse operational scan locations (city/country) plus the
  // ParcelShop/locker name when the provider supplies it. Street, postcode
  // and recipient contact fields in the same object are still dropped.
  const shop = text(raw.address.parcelShopName ?? raw.address.shopName ?? raw.parcelShop, 200);
  return [shop, plainText(raw.address.countryName, 80), plainText(raw.address.city, 120)]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);
}

/**
 * The ParcelShop the tracking page prints for the parcel: its name, then its street and town on
 * their own lines when both are given. Its id and opening hours are not read.
 */
function parcelShop(parcel: JsonObject): string | null {
  const address = isRecord(parcel.parcelShop) && isRecord(parcel.parcelShop.address) ? parcel.parcelShop.address : null;
  const name = plainText(address?.name1, 120);
  if (!address || !name) return null;
  const area = isRecord(address.postalArea) ? address.postalArea : {};
  const street = plainText(address.street1, 120);
  const city = plainText(area.city, 80);
  if (!street || !city) return name;
  return `${name}\n${[street, plainText(address.blockNo1, 20)].filter(Boolean).join(' ')}\n${
    [plainText(area.postalCodeDisplay, 16), city].filter(Boolean).join(' ')}`;
}

function parcelShopName(parcel: JsonObject): string | null {
  for (const event of records(parcel.history)) {
    const name = eventLocation(event);
    if (/parcel.?shop|locker|point relais|paketshop/i.test(name) && name) return name.slice(0, 200);
  }
  return null;
}

function parcelWeight(parcel: JsonObject): number | null {
  for (const info of records(parcel.infos)) {
    const label = text(info.label ?? info.name, 32).toLocaleLowerCase('en-US');
    const value = text(info.value ?? info.text, 32);
    if (!/weight|poids|gewicht/.test(label)) continue;
    const match = /([\d.,]+)\s*kg/i.exec(value);
    if (match) {
      const parsed = Number(match[1]!.replace(',', '.'));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function parseEvents(parcel: JsonObject): ParsedEvent[] {
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  records(parcel.history).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, sourceIndex) => {
    const description = plainText(raw.evtDscr) || plainText(raw.description);
    const time = parseEventTime(raw.date, raw.time);
    if (!description || !time) return;
    const location = eventLocation(raw);
    const code = text(raw.evtNo ?? raw.code, 32);
    const identity = JSON.stringify([time.iso, location, description, code]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = GLS_STATUSES.get(statusCode(raw.status)) ?? classifyDescription(description);
    parsed.push({
      sourceIndex,
      timestamp: time.timestamp,
      status: classified.status,
      event: {
        time: time.iso,
        location,
        description,
        stage: classified.stage,
        ...(/^[A-Z0-9._-]{1,32}$/i.test(code) ? { provider_code: code } : {}),
      },
    });
  });
  parsed.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  return parsed.slice(0, MAX_EVENTS_TO_RETURN);
}

function expectedDelivery(parcel: JsonObject): string | null {
  if (!isRecord(parcel.arrivalTime)) return null;
  const value = plainText(parcel.arrivalTime.value, 128);
  const match = value.match(/\b(\d{1,2}[-/.][A-Za-z]{3}|\d{1,2}[-/.]\d{1,2})[-/.](\d{4})\b/);
  if (!match) return null;
  const raw = match[0];
  for (const format of ['d-MMM-yyyy', 'd/MM/yyyy', 'd.MM.yyyy']) {
    const parsed = firstOccurrence(DateTime.fromFormat(raw, format, { zone: 'Europe/Zurich', locale: 'en' }));
    if (parsed.isValid) return parsed.toISODate();
  }
  return null;
}

export function parseGLSSwitzerlandTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const parcel = selectGLSParcel(payload, rawTrackingNumber);
  if (!isRecord(parcel.progressBar)) {
    throw new SchemaError(PROVIDER, 'GLS did not return a shipment status');
  }
  const progress = parcel.progressBar;
  const current = records(progress.statusBar).find((entry) => (
    statusCode(entry.imageStatus) === 'CURRENT'
  ));
  const currentCode = statusCode(progress.statusInfo) || statusCode(current?.status);
  const currentMetadata = GLS_STATUSES.get(currentCode);
  const currentText = plainText(current?.statusText)
    || plainText(progress.statusText)
    || plainText(current?.imageText)
    || 'Tracking information received';
  const parsedEvents = parseEvents(parcel);
  const events = parsedEvents.map(({ event }) => event);
  const latestKnownEvent = parsedEvents.find((event) => event.status !== 'unknown');
  // Newest history wording outranks a stale progress-bar heading (locker
  // drops stick at "Delivered" upstream); the event description is the raw
  // status. A returning parcel overrides any in-transit heading.
  const newestDescription = events[0]?.description ?? currentText;
  const status = isReturnParcel(parcel)
    ? 'exception'
    : currentMetadata?.status ?? latestKnownEvent?.status ?? 'unknown';
  const stage = isReturnParcel(parcel)
    ? 'returned'
    : currentMetadata?.stage ?? latestKnownEvent?.event.stage ?? 'in_transit';
  const shop = parcelShop(parcel) ?? parcelShopName(parcel);
  const weight = parcelWeight(parcel);
  const pickup = stage === 'ready_for_pickup' && shop ? { pickup_point: shop } : {};
  return {
    status,
    canonical_tracking_number: normalizedResponseIdentifier(parcel.tuNo),
    ...(records(parcel.owners).some((owner) => statusCode(owner.type) === 'DELIVERY' && statusCode(owner.code) === 'CH01')
      ? { delivery_carrier: 'swiss-post' as const, delivery_tracking_number: normalizedResponseIdentifier(parcel.tuNo) } : {}),
    current_stage: stage,
    last_status_text: newestDescription,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status)
      ? null
      : expectedDelivery(parcel),
    timezone: 'Europe/Zurich',
    ...pickup,
    ...(weight != null ? { weight_kg: weight } : {}),
    ...(status === 'delivered' && events[0]?.time ? { delivered_at: events[0].time } : {}),
    events,
  };
}

function ownerCode(parcel: JsonObject): string {
  return records(parcel.owners).reduce((found, owner) => (
    found || (statusCode(owner.type) === 'REQUEST' ? text(owner.code, 32) : '')
  ), '');
}

function pageHeaders(userAgent: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Accept-Language': 'en-CH,en;q=0.9',
    Origin: 'https://gls-group.eu',
    Referer: `${TRACKING_PAGE}/`,
    'User-Agent': userAgent,
  };
}

export class GLSSwitzerlandTracker {
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | GLSSwitzerlandOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, now: Date.now, fetcher: undefined, userAgent: undefined }
      : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('GLS Switzerland timeout must be positive');
    }
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(rawTrackingNumber: string, rawPostcode = '', context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
    // Up to two requests, each with the full request timeout.
    const budget = lookupBudget(context, 2 * this.timeoutMs);
    const overview = await this.request(glsSwitzerlandOverviewApiUrl(trackingNumber, this.now()), budget, GLS_OVERVIEW_NOT_FOUND);
    const parcel = selectGLSParcel(overview, trackingNumber);
    if (!rawPostcode.trim()) return parseGLSSwitzerlandTrackingResponse(overview, trackingNumber);

    const parcelNumber = normalizedResponseIdentifier(parcel.tuNo);
    if (!/^\d{11,14}$/.test(parcelNumber)) {
      throw new SchemaError(PROVIDER, 'GLS did not return a numeric parcel number');
    }
    const detail = await this.request(glsSwitzerlandDetailApiUrl(
      parcelNumber,
      rawPostcode,
      this.now(),
      ownerCode(parcel),
    ), budget, GLS_DETAIL_NOT_FOUND, GLS_POSTCODE_MISMATCH);
    const result = parseGLSSwitzerlandTrackingResponse(detail, parcelNumber);
    const overviewResult = parseGLSSwitzerlandTrackingResponse(overview, trackingNumber);
    return { ...result, ...glsDeliveryReference(overviewResult) };
  }

  /**
   * Whether GLS knows a number, from the overview alone: no postcode is sent.
   * Only GLS's own not-found reply says it does not; any other failure stays one.
   */
  async recognizes(rawTrackingNumber: string, context: TrackingContext = {}): Promise<boolean> {
    const trackingNumber = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { response, bytes } = await fetchBounded(glsSwitzerlandOverviewApiUrl(trackingNumber, this.now()), {
      signal: budget.signal,
      headers: pageHeaders(this.#userAgent),
    }, {
      provider: 'GLS Switzerland tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    if (response.status === 404) {
      if (GLS_OVERVIEW_NOT_FOUND.includes(glsLastError(bytes))) return false;
      throw new IndeterminateError(PROVIDER, 'GLS returned HTTP 404 without its own not-found reply', { status: 404 });
    }
    if (!response.ok) throw new UpstreamHttpError('GLS Switzerland tracking', response.status);
    try {
      return parseGLSSwitzerlandTrackingResponse(parseJsonBytes(bytes, PROVIDER), trackingNumber).status !== 'unknown';
    } catch (error) {
      if (error instanceof GLSSwitzerlandTrackingError) return false;
      throw error;
    }
  }

  /**
   * A request that fails to reach GLS, or hangs, is sent once more: the first gets at most half of
   * what is left, so the second fits in the rest.
   */
  private async request(url: string, budget: LookupBudget, notFound: readonly string[], mismatch: readonly string[] = []): Promise<unknown> {
    const { response, bytes } = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(url, {
      signal: budget.signal,
      headers: pageHeaders(this.#userAgent),
    }, {
      provider: 'GLS Switzerland tracking',
      timeoutMs: Math.min(this.timeoutMs, timeoutMs),
      maxBytes: MAX_RESPONSE_BYTES,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    }));
    // GLS answers a number or postcode it does not match with a 404 carrying its own code. Any other
    // 404 is inconclusive, and a 400 or 403 can be a challenge: neither reads as a missing parcel.
    if (response.status === 404) {
      if (notFound.includes(glsLastError(bytes))) throw new GLSSwitzerlandTrackingError();
      if (mismatch.includes(glsLastError(bytes))) throw glsPostcodeMismatch(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'GLS returned HTTP 404 without its own not-found reply', { status: 404 });
    }
    if (!response.ok) throw new UpstreamHttpError('GLS Switzerland tracking', response.status);
    return parseJsonBytes(bytes, PROVIDER);
  }
}

/** Keep the verified overview's delivery owner when the postcode detail omits it. */
export function glsDeliveryReference(result: CarrierResult): Partial<CarrierResult> {
  return result.delivery_carrier ? { delivery_carrier: result.delivery_carrier, delivery_tracking_number: result.delivery_tracking_number } : {};
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSSwitzerlandTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'gls-ch',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
