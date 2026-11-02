
import { lookupBudget, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { explicitOffsetTime, isoTime, zonedTime, type ParsedTime } from '../../core/time/index.js';
import { cleanScalar, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { referenceConsignment } from './reference.js';
import { statusFor } from './status.js';

// Protocol provenance (inspected 2026-08-30): the source map published by the
// official public tracker posts { Identifier } to this anonymous endpoint and
// treats a null Data property as a clean not-found result.
// https://apv.swisspost-cargo.com/static/js/907.9a0b939a.chunk.js.map
const TRACKING_API = 'https://eosapi.swisspost-cargo.com/api/trackandtrace/public';
const TRACKING_PAGE = 'https://apv.swisspost-cargo.com/public/trackandtrace';
const PROVIDER = 'Swiss Post Cargo';
const ZONE = 'Europe/Zurich';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
/** The delivery photo and signature rows: proof of a delivery, not scans of their own. */
const DELIVERY_PROOF_CODES = new Set(['IMG', 'SIG']);

export interface SwissPostCargoOptions {
  timeoutMs?: number;
  userAgent?: string;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  /** Test seam for the clock that decides which reference shipments are current. */
  now?: () => number;
}

/**
 * The endpoint sends Swiss wall-clock ISO-8601 without an offset
 * (`2026-08-30T12:30:00.777`). It is read in Europe/Zurich, never in the
 * server's zone, and so are the dotted and slashed fallbacks. An explicit
 * offset or `Z` is kept as sent.
 */
function eventTimestamp(value: unknown): ParsedTime | null {
  return isoTime(value, ZONE)
    ?? zonedTime(value, 'dd.MM.yyyy HH:mm:ss', ZONE)
    ?? zonedTime(value, 'dd.MM.yyyy HH:mm', ZONE)
    ?? zonedTime(value, 'dd/MM/yyyy HH:mm:ss', ZONE);
}

export function normalizeSwissPostCargoTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{6,40}$/.test(value)) {
    throw new InvalidInputError(PROVIDER, `${PROVIDER} tracking requires a 6- to 40-character barcode or reference`);
  }
  return value;
}

/**
 * The spellings to ask for, in order. eos matches an identifier exactly except
 * for case, while stored numbers lose their punctuation: a reference printed
 * `AB-12345678` arrives as `AB12345678`. A letter prefix followed by digits is
 * asked again with the dash between them once eos does not know the compact form.
 * eos takes seconds to refuse anything longer than an SSCC's 20 characters, so
 * a dash is not guessed past that length.
 */
export function swissPostCargoIdentifiers(raw: string): string[] {
  const compact = normalizeSwissPostCargoTrackingNumber(raw);
  const prefixed = compact.length < 20 ? /^([A-Z]+)(\d+)$/.exec(compact) : null;
  return prefixed ? [compact, `${prefixed[1]}-${prefixed[2]}`] : [compact];
}

export function swissPostCargoTrackingUrl(raw: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeSwissPostCargoTrackingNumber(raw))}`;
}

function comparableIdentifier(value: unknown): string {
  return cleanScalar(value, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
}

export function parseSwissPostCargoResponse(
  payload: unknown,
  rawTrackingNumber: string,
  now = Date.now(),
): CarrierResult {
  const trackingNumber = normalizeSwissPostCargoTrackingNumber(rawTrackingNumber);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'Data')) {
    throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned an invalid tracking response');
  }
  if (payload.Data === null) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(payload.Data) || payload.Data.length === 0) {
    throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned an invalid tracking response');
  }
  let shipments = payload.Data.filter(isRecord);
  if (shipments.length === 0) {
    throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned an invalid tracking response');
  }
  const responseType = Number(payload.Type);
  if (responseType !== 1 && responseType !== 2 && responseType !== 3) {
    throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned an invalid tracking response type');
  }
  if (responseType !== 2) {
    const identifiers = shipments
      .map((shipment) => comparableIdentifier(shipment.Identifier))
      .filter(Boolean);
    if (identifiers.length === 0) {
      throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned no shipment identifier');
    }
    if (!identifiers.includes(trackingNumber)) {
      throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned a different shipment');
    }
    shipments = shipments.filter((shipment) => comparableIdentifier(shipment.Identifier) === trackingNumber);
  }
  // Type 3, which the tracker's source map does not name, relays Swiss Post's
  // own scans (placeholder `PST` codes, no place) for a parcel barcode the eos
  // system does not hold. The parcel is Swiss Post's, so this is a not-found
  // here and routing asks the Swiss Post adapter instead.
  if (responseType === 3) {
    throw new NotFoundError(PROVIDER, 'Swiss Post Cargo only relays Swiss Post tracking for this barcode');
  }
  if (responseType === 2) {
    shipments = referenceConsignment(shipments, (shipment) => (
      Array.isArray(shipment.History) ? shipment.History.filter(isRecord) : []
    ).map((row) => eventTimestamp(row.TimeStamp)?.timestamp ?? Number.NaN), PROVIDER, now);
  }

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    proof: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const shipment of shipments.slice(0, 100)) {
    if (!Array.isArray(shipment.History)) continue;
    const rows = [];
    for (const candidate of shipment.History.slice(0, 500)) {
      if (!isRecord(candidate)) continue;
      const time = eventTimestamp(candidate.TimeStamp);
      const description = cleanScalar(candidate.Description);
      if (!time || !description) continue;
      const code = cleanScalar(candidate.Status, 32).toLocaleUpperCase('en-US');
      rows.push({
        time, description, code, location: cleanScalar(candidate.City, 120),
        classified: statusFor(code, description), proof: DELIVERY_PROOF_CODES.has(code),
      });
    }
    if (listsNewestFirst(rows.map(({ time }) => ({ time: time.iso }))) === false) rows.reverse();
    // A barcode's photo and signature are part of its delivery scan: folded
    // into it, they never stand on top of it.
    const deliveryScan = rows.some((row) => !row.proof && row.classified.stage === 'delivered');
    for (const { time, description, code, location, classified, proof } of rows) {
      if (proof && deliveryScan) continue;
      const identity = JSON.stringify([time.iso, location, description, code]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      parsedEvents.push({
        event: {
          time: time.iso,
          location,
          description,
          stage: classified.stage,
          ...(code ? { provider_code: code } : {}),
        },
        status: classified.status,
        timestamp: time.timestamp,
        proof,
      });
    }
  }
  // Ties keep the carrier's order, except that a photo or signature never
  // passes a scan made at the same instant.
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp || Number(left.proof) - Number(right.proof));
  const events = parsedEvents.slice(0, 100);
  if (events.length === 0) {
    throw new SchemaError(PROVIDER, 'Swiss Post Cargo returned no usable tracking events');
  }
  const latest = events[0]!;
  return {
    status: latest.status,
    current_stage: latest.event.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time,
    expected_delivery: null,
    ...(latest.status === 'delivered' && latest.event.time ? { delivered_at: latest.event.time } : {}),
    timezone: ZONE,
    events: events.map(({ event }) => event),
    tracking_url: swissPostCargoTrackingUrl(trackingNumber),
  };
}

export class SwissPostCargoTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #userAgent: string;

  constructor(options: number | SwissPostCargoOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher, now = Date.now, userAgent }: SwissPostCargoOptions = typeof options === 'number' ? { timeoutMs: options } : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Swiss Post Cargo timeout must be positive');
    }
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
    this.#now = now;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const identifiers = swissPostCargoIdentifiers(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    for (const [index, identifier] of identifiers.entries()) {
      const { bytes } = await fetchBounded(TRACKING_API, {
        method: 'POST',
        signal: budget.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-CH,en;q=0.9',
          'Content-Type': 'application/json',
          Origin: 'https://apv.swisspost-cargo.com',
          Referer: `${TRACKING_PAGE}/`,
          'User-Agent': this.#userAgent,
        },
        body: JSON.stringify({ Identifier: identifier }),
      }, {
        provider: 'Swiss Post Cargo tracking',
        timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
        maxBytes: MAX_RESPONSE_BYTES,
        ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
      });
      const payload = parseJsonBytes(bytes, PROVIDER);
      // Only an identifier eos does not know at all is worth another spelling.
      if (index < identifiers.length - 1 && isRecord(payload) && payload.Data === null) continue;
      return {
        ...parseSwissPostCargoResponse(payload, identifiers[0]!, this.#now()),
        // The portal finds the shipment only under the spelling eos knows.
        tracking_url: `${TRACKING_PAGE}/${encodeURIComponent(identifier)}`,
      };
    }
    throw new NotFoundError(PROVIDER);
  }

  /** Known when eos returns dated scans for the number; its 404s are the unknown answer. */
  async recognizes(trackingNumber: string, context: TrackingContext = {}): Promise<Recognition> {
    try {
      const result = await this.fetch(trackingNumber, context);
      const times = (result.events ?? []).map((event) => explicitOffsetTime(event.time)?.timestamp)
        .filter((value): value is number => value !== undefined);
      return {
        known: times.length > 0,
        lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return { known: false };
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwissPostCargoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'swiss-post-cargo',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognizes(number, context),
  };
};
