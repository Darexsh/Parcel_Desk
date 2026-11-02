
/**
 * PostLogistics tracking.
 *
 * PostLogistics now trades as Swiss Post Cargo, and its tracker moved to
 * `apv.swisspost-cargo.com`, which posts the identifier to
 * `eosapi.swisspost-cargo.com/api/trackandtrace/public`. The former
 * `postlogistics.ch` hosts answer 404. The response says what the identifier
 * was:
 *
 * - `Type` 1: a barcode. The answer may contain several shipments, so only the
 *   one whose `Identifier` equals the requested barcode is read.
 * - `Type` 2: a customer reference that resolved to one or more barcodes.
 *   Shippers reuse references, so only the one current consignment among them
 *   is merged; an answer without one is a not-found (`referenceConsignment`).
 * - `Type` 3: a Swiss Post parcel barcode PostLogistics does not hold. The
 *   endpoint relays Swiss Post's own scans (placeholder `PST` codes, no place),
 *   so the parcel is Swiss Post's: once the echo matches, this is a not-found
 *   and routing asks the Swiss Post adapter instead.
 *
 * Any other type is refused rather than guessed at. A `Data: null` answer is
 * PostLogistics' explicit "unknown identifier".
 */
import { lookupBudget, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { referenceConsignment } from '../swiss-post-cargo/reference.js';
import { postlogisticsIdentifier } from './number.js';
import { POSTLOGISTICS_IMAGE_CODE, postlogisticsStage, postlogisticsStatus } from './status.js';

const PROVIDER = 'PostLogistics';
const UPSTREAM = 'PostLogistics tracking';
// The endpoint words its scans in the culture's language, whatever Accept-Language says.
const TRACK_URL = 'https://eosapi.swisspost-cargo.com/api/trackandtrace/public?culture=en-EN';
const DEFAULT_TIMEOUT_MS = 15_000;
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function comparableIdentifier(value: unknown): string {
  return text(value).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

/**
 * A history without the `IMG` entries that only say a picture was taken with
 * a scan: they share that scan's instant, and the scan says what happened.
 */
function scans(history: JsonObject[]): JsonObject[] {
  return history.filter((entry) => text(entry.Status) !== POSTLOGISTICS_IMAGE_CODE
    || !history.some((other) => other !== entry && text(other.TimeStamp) === text(entry.TimeStamp)));
}

/** Projects one track-and-trace payload. Pure: the offline tests target this. */
export function parsePostlogisticsTrackingResponse(value: unknown, trackingNumber: string, now = Date.now()): CarrierResult {
  const payload = record(value);
  if (payload.Data === null) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(payload.Data)) {
    throw new SchemaError(PROVIDER, 'PostLogistics returned an invalid tracking response');
  }
  const items = recordArray(payload.Data);
  if (items.length !== payload.Data.length) {
    throw new SchemaError(PROVIDER, 'PostLogistics returned an invalid shipment entry');
  }
  if (items.length === 0) throw new SchemaError(PROVIDER, 'PostLogistics did not return a shipment entry');
  const responseType = Number(payload.Type);
  if (responseType !== 1 && responseType !== 2 && responseType !== 3) {
    throw new SchemaError(PROVIDER, 'PostLogistics returned an invalid tracking response type');
  }
  const identified = items.filter((candidate) => comparableIdentifier(candidate.Identifier));
  if (identified.length === 0) {
    throw new SchemaError(PROVIDER, 'PostLogistics did not return a shipment identifier');
  }
  let shipments = identified;
  if (responseType !== 2) {
    const requested = comparableIdentifier(trackingNumber);
    shipments = identified.filter(
      (candidate) => comparableIdentifier(candidate.Identifier) === requested,
    );
    if (shipments.length === 0) {
      throw new SchemaError(PROVIDER, 'PostLogistics returned a different shipment');
    }
  }
  if (responseType === 3) {
    throw new NotFoundError(PROVIDER, 'PostLogistics only relays Swiss Post tracking for this barcode');
  }
  if (responseType === 2) {
    shipments = referenceConsignment(shipments, (shipment) => recordArray(shipment.History)
      .map((event) => Date.parse(text(event.TimeStamp))), PROVIDER, now);
  }
  const history = shipments.flatMap((shipment) => scans(recordArray(shipment.History)));
  // Merged references interleave several barcodes, so order by absolute
  // instant. The endpoint lists a history oldest first, so of two entries
  // that share an instant the later one is the newer.
  const orderedHistory = history.map((event, index) => {
    const rawTimestamp = text(event.TimeStamp);
    const parsedTimestamp = Date.parse(rawTimestamp);
    return {
      event,
      index,
      timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.NEGATIVE_INFINITY,
    };
  }).sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = orderedHistory.map(({ event }): CarrierEvent => {
    const code = text(event.Status);
    return {
      time: text(event.TimeStamp),
      location: text(event.City),
      description: text(event.Description),
      stage: postlogisticsStage(code),
      ...(code ? { provider_code: code } : {}),
    };
  });
  const latest = orderedHistory[0]?.event ?? {};
  const latestStatus = text(latest.Status);
  const eta = shipments.map((shipment) => record(shipment.DriveAndArrive))
    .map((drive) => text(drive.PlannedDeliveryDate) || text(drive.EstimatedArrival))
    .find(Boolean) ?? '';
  const status = postlogisticsStatus(latestStatus);
  return {
    status,
    current_stage: postlogisticsStage(latestStatus),
    last_status_text: text(latest.Description) || latestStatus,
    last_update: text(latest.TimeStamp) || null,
    expected_delivery: eta ? eta.slice(0, 10) : null,
    ...(status === 'delivered' && text(latest.TimeStamp) ? { delivered_at: text(latest.TimeStamp) } : {}),
    events,
  };
}

export class PostlogisticsTracker {
  private readonly fetcher: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly userAgent: string;

  constructor(options: { fetcher?: typeof fetch; timeoutMs?: number; now?: () => number; userAgent?: string } = {}) {
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const dashed = postlogisticsIdentifier(trackingNumber);
    const identifiers = dashed === trackingNumber ? [trackingNumber] : [trackingNumber, dashed];
    const budget = lookupBudget(context, this.timeoutMs);
    for (const [index, identifier] of identifiers.entries()) {
      const { bytes } = await fetchBounded(
        TRACK_URL,
        {
          method: 'POST',
          headers: {
            ...BASE_HEADERS,
            'User-Agent': this.userAgent,
            'Content-Type': 'application/json',
            Origin: 'https://apv.swisspost-cargo.com',
            Referer: 'https://apv.swisspost-cargo.com/',
          },
          body: JSON.stringify({ Identifier: identifier }),
          signal: budget.signal,
        },
        { provider: UPSTREAM, timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()), fetcher: this.fetcher },
      );
      try {
        return parsePostlogisticsTrackingResponse(parseJsonBytes(bytes, UPSTREAM), trackingNumber, this.now());
      } catch (error) {
        if (!(error instanceof NotFoundError) || index === identifiers.length - 1) throw error;
      }
    }
    throw new NotFoundError(PROVIDER);
  }

  async recognizes(trackingNumber: string, context: TrackingContext = {}): Promise<Recognition> {
    try {
      const result = await this.fetch(trackingNumber, context);
      const events = (result.events ?? []).filter((event) => event.description && event.time);
      const times = events.map((event) => explicitOffsetTime(event.time)?.timestamp)
        .filter((value): value is number => value !== undefined);
      return {
        known: events.length > 0,
        lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      };
    } catch (error) {
      if (error instanceof NotFoundError) return { known: false };
      throw error;
    }
  }
}

/** Kept for the host's legacy dispatch chain until it is deleted. */
export async function fetchPostlogistics(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
  return new PostlogisticsTracker().fetch(trackingNumber, context);
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostlogisticsTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'postlogistics',
    // Keyless POST, with one alternate spelling after a compact not-found.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognizes(number, context),
  };
};
