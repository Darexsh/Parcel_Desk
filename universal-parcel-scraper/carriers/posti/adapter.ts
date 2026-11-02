
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/index.js';
import { CarrierError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isPostiPlacelessLabel } from './identity.js';
import { postiEventStage, postiStatus } from './status.js';

const TOKEN_URL = 'https://auth-service.posti.fi/api/v1/anonymous_token';
const GRAPHQL_URL = 'https://graphql.posti.fi/graphql';
const DEFAULT_TIMEOUT_MS = 15_000;

// The public tracking page uses this operation with PUBLIC_SHIPMENTS. Select
// only tracking fields and the pickup point's own address; no account,
// recipient address, payment or pickup code.
const QUERY = `query SearchShipments($searchTerms: [String!]!, $locale: String) {
  consumerSearchShipments(page: 1, pageSize: 20, type: PUBLIC_SHIPMENTS, searchTerms: $searchTerms, locale: $locale) {
    totalHits
    hits {
      displayId
      status { main subStatus }
      measurements { weight { unit value } height { unit value } width { unit value } length { unit value } }
      pickupPoint { type address { publicName streetAddress postcode city } }
      events { city eventDescription reasonDescription timestamp }
      packages { trackingNumber }
    }
  }
}`;

export function normalizePostiTrackingNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{4,40}$/.test(number)) throw new InvalidInputError('Posti', 'Posti requires a 4–40 character tracking number');
  return number;
}

class PostiSessionExpiredError extends CarrierError {
  constructor() {
    super('indeterminate', 'Posti', 'Posti anonymous session expired');
    this.name = 'PostiSessionExpiredError';
  }
}

function assertGraphql(payload: unknown): asserts payload is Record<string, unknown> {
  if (!isRecord(payload)) throw new SchemaError('Posti');
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    if (payload.errors.some((error) => isRecord(error) && error.errorType === 'Unauthorized')) {
      throw new PostiSessionExpiredError();
    }
    throw new IndeterminateError('Posti', 'Posti could not complete the tracking query');
  }
  if (payload.errors != null && !Array.isArray(payload.errors)) throw new SchemaError('Posti');
}

// Pickup point types whose address is a public business's: Posti's lockers and
// service points. A private locker stands in the recipient's building.
const PUBLIC_POINTS = new Set(['LOCKER', 'LOCKER_OUTDOOR', 'POSTI_SERVICE_POINT']);

/**
 * The pickup point's name, then its street and "postcode city", as Posti's
 * tracker lays them out. A private locker, or a point of unknown type, keeps
 * only its town after the name: its street could be the recipient's.
 */
function pickupPoint(raw: unknown): string | null {
  const point = isRecord(raw) ? raw : {};
  const address = isRecord(point.address) ? point.address : {};
  const name = clean(address.publicName, 160);
  if (!name) return null;
  const street = clean(address.streetAddress, 120);
  const city = clean(address.city, 80);
  if (street && city && typeof point.type === 'string' && PUBLIC_POINTS.has(point.type)) {
    return [name, street, [clean(address.postcode, 16), city].filter(Boolean).join(' ')].join('\n');
  }
  return [name, city].filter(Boolean).join('\n');
}

// Posti's main status stays at pre-advice until the item reaches Posti, while
// an inbound item already moves abroad under the origin post's scans.
const BEFORE_ARRIVAL = new Set(['ORDER_RECEIVED', 'WAITING']);
const MOVING = new Set(['accepted', 'in_transit', 'customs']);

/** The newest scan's movement where the main status still says pre-advice. */
function currentStatus(main: ClassifiedStatus | undefined, code: string, events: readonly CarrierEvent[]): ClassifiedStatus | undefined {
  if (!main || !BEFORE_ARRIVAL.has(code)) return main;
  const moved = events.find((event) => event.stage && event.stage !== 'pending')?.stage;
  return moved && MOVING.has(moved) ? { status: 'in_transit', stage: moved as Stage } : main;
}

/**
 * Whether the parcel waits at its pickup point, or was collected there: its
 * last movement before the delivery made it ready for pickup.
 */
function atPickupPoint(stage: string | undefined, events: readonly CarrierEvent[]): boolean {
  return stage === 'ready_for_pickup' || (stage === 'delivered' && lastMovement(events) === 'ready_for_pickup');
}

function measurement(raw: unknown, units: Record<string, number>): number | null {
  if (!isRecord(raw) || typeof raw.unit !== 'string' || !Object.hasOwn(units, raw.unit.toLowerCase())) return null;
  if (typeof raw.value !== 'number' && (typeof raw.value !== 'string' || !raw.value.trim())) return null;
  const value = Number(raw.value) * units[raw.unit.toLowerCase()]!;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Posti's copies of the origin post's scans in the country of origin carry
// that post's wall clock under Helsinki's offset, an hour before the post's
// own scans. Poczta Polska's and La Poste's own scans confirm it to the
// minute; items from other posts keep the time Posti states.
const ORIGIN_POST_ZONES: Readonly<Record<string, string>> = { FR: 'Europe/Paris', PL: 'Europe/Warsaw' };
const IN_COUNTRY_OF_ORIGIN = /\bcountry of origin\b/i;

/** A placeless scan in the country of origin of an item from a post whose own scans confirm the clock, on that post's clock. */
function originPostTime(time: string, label: string, location: string, number: string): string {
  const zone = isValidS10TrackingNumber(number) ? ORIGIN_POST_ZONES[number.slice(-2)] : undefined;
  if (!zone || !time || location || !IN_COUNTRY_OF_ORIGIN.test(label)) return time;
  const read = firstOccurrence(DateTime.fromObject(DateTime.fromISO(time).setZone('Europe/Helsinki').toObject(), { zone }));
  return (read.isValid && read.toISO({ suppressMilliseconds: true })) || time;
}

/** Identity-bound projection; empty search, malformed replies and wrong identities remain distinct. */
export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizePostiTrackingNumber(trackingNumber);
  assertGraphql(payload);
  const search = isRecord(payload.data) ? payload.data.consumerSearchShipments : undefined;
  if (!isRecord(search) || !Number.isSafeInteger(search.totalHits) || Number(search.totalHits) < 0
    || !Array.isArray(search.hits)) throw new SchemaError('Posti');
  if (search.totalHits === 0 && search.hits.length === 0) throw new NotFoundError('Posti');
  if (search.hits.length === 0 || search.totalHits === 0) throw new SchemaError('Posti');
  const matches = search.hits.filter((hit) => isRecord(hit) && clean(hit.displayId, 64).toUpperCase() === requested);
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError('Posti', 'Posti returned a different or ambiguous shipment');
  const hit = matches[0];
  if (!isRecord(hit.status) || typeof hit.status.main !== 'string'
    || !Array.isArray(hit.status.subStatus) || !hit.status.subStatus.every((code) => typeof code === 'string')
    || !Array.isArray(hit.events)) throw new SchemaError('Posti');
  // A group overview can contain several parcels. Do not attribute another
  // parcel's delivered scan to this identity.
  if (hit.packages != null && !Array.isArray(hit.packages)) throw new SchemaError('Posti');
  const packages = Array.isArray(hit.packages) ? hit.packages : [];
  if (packages.some((item) => !isRecord(item) || clean(item.trackingNumber, 64).toUpperCase() !== requested)) {
    throw new SchemaError('Posti', 'Posti returned a multi-parcel overview');
  }
  const scans: CarrierEvent[] = hit.events.map((event): CarrierEvent => {
    if (!isRecord(event) || typeof event.eventDescription !== 'string') throw new SchemaError('Posti');
    const description = clean(event.eventDescription);
    const reason = clean(event.reasonDescription);
    const city = clean(event.city, 160);
    const location = isPostiPlacelessLabel(city) ? '' : city;
    return {
      // The status and its explanation are separate sentences, and the status often has no stop.
      description: reason && description ? `${/[.!?]$/.test(description) ? description : `${description}.`} ${reason}` : description || reason,
      time: originPostTime(explicitOffsetTime(event.timestamp)?.iso ?? '', description, location, requested),
      location,
      stage: postiEventStage(description),
    };
  });
  if (listsNewestFirst(scans) === false) scans.reverse();
  const events = scans.sort((left, right) => (Date.parse(right.time || '') || 0) - (Date.parse(left.time || '') || 0)).slice(0, 100);
  const current = currentStatus(postiStatus(hit.status.main, hit.status.subStatus), hit.status.main, events);
  const measurements = isRecord(hit.measurements) ? hit.measurements : {};
  const dimensions = ['length', 'width', 'height'].map((field) => measurement(measurements[field], { cm: 1, mm: 0.1, m: 100 }));
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage } : {}),
    last_status_text: events[0]?.description || hit.status.main,
    last_update: events[0]?.time || null,
    provider_status: hit.status.main,
    weight_kg: measurement(measurements.weight, { kg: 1, g: 0.001 }),
    dimensions_text: dimensions.every((value) => value !== null) ? `${dimensions.join(' × ')} cm` : null,
    // Posti's tracker shows the point at any status, a planned one in transit included.
    pickup_point: atPickupPoint(current?.stage, events) ? pickupPoint(hit.pickupPoint) : null,
    timezone: 'Europe/Helsinki',
    events,
  };
}

interface Session { authorization: string; idToken: string; expiresAt: number }

function expiry(token: string): number {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    return isRecord(claims) && typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0;
  } catch { return 0; }
}

export class PostiTracker {
  private session?: Session;

  constructor(private readonly options: { fetcher?: typeof fetch; timeoutMs?: number; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostiTrackingNumber(trackingNumber);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Posti timeout must be positive');
    const deadline = performance.now() + budgetMs;
    const request = async (url: string, init: RequestInit & { headers?: Record<string, string> }, step: StepContext): Promise<unknown> => {
      step.signal.throwIfAborted();
      const headers = { ...init.headers, 'User-Agent': userAgentOf(this.options.userAgent) };
      const { bytes } = await fetchBounded(url, { ...init, headers }, {
        provider: 'Posti', maxBytes: 2_000_000,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        fetcher: (input, options) => (this.options.fetcher ?? fetch)(input, {
          ...options, signal: AbortSignal.any([step.signal, ...(options?.signal ? [options.signal] : [])]),
        }),
      });
      return parseJsonBytes(bytes, 'Posti');
    };
    const lookup = async (step: StepContext, refresh = false): Promise<CarrierResult> => {
      if (refresh || !this.session || this.session.expiresAt <= Date.now() + 30_000) {
        this.session = undefined;
        const token = await request(TOKEN_URL, { method: 'POST' }, step);
        const role: unknown = isRecord(token) && Array.isArray(token.role_tokens)
          ? token.role_tokens.find((value) => isRecord(value) && value.type === 'anonymous') : undefined;
        if (!isRecord(token) || typeof token.id_token !== 'string' || !token.id_token
          || !isRecord(role) || typeof role.token !== 'string' || !role.token) {
          throw new SchemaError('Posti', 'Posti returned an invalid anonymous session');
        }
        this.session = { authorization: role.token, idToken: token.id_token,
          expiresAt: Math.min(expiry(role.token), expiry(token.id_token)) };
      }
      const session = this.session;
      let payload: unknown;
      try {
        payload = await request(GRAPHQL_URL, {
          method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            Authorization: session.authorization, 'X-Posti-Token': `Bearer ${session.idToken}`,
          },
          body: JSON.stringify({ operationName: 'SearchShipments', query: QUERY, variables: { searchTerms: [number], locale: 'en' } }),
        }, step);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [401, 403].includes(error.status)) {
          if (this.session === session) this.session = undefined;
          throw new PostiSessionExpiredError();
        }
        throw error;
      }
      try { return parse(payload, number); }
      catch (error) {
        if (error instanceof PostiSessionExpiredError && this.session === session) this.session = undefined;
        throw error;
      }
    };
    return runSteps({ carrier: 'posti', budgetMs, signal: context.signal, recorder: this.options.recorder }, [
      { id: 'direct', run: (step) => lookup(step) },
      { id: 'refresh', recovers: (error) => error instanceof PostiSessionExpiredError, run: (step) => lookup(step, true) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posti', recordsSteps: true, steps: ['direct', 'refresh'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostiTrackingNumber(number))),
  };
};
