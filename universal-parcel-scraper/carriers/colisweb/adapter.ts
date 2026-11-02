/**
 * Colisweb: the anonymous search endpoint behind colisweb.com/suivi-livraison.
 *
 * One bounded POST per lookup ('direct' step). Colisweb schedules appointed
 * deliveries for retailers, so its response is about a delivery slot rather than
 * a parcel journey: it carries the retailer's name, the recipient block and the
 * booked time window next to three milestone timestamps. `parse()` keeps the
 * milestones, the step, the booked slot and the retailer's name; anything
 * describing the recipient is dropped.
 */

import { DateTime } from 'luxon';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { UpstreamHttpError, clean, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { Stage } from '../../generated/catalog.js';
import { classifyStatus, type ClassifiedStatus } from './status.js';

export { classifyStatus } from './status.js';

const PROVIDER = 'Colisweb';
const TRACKING_ENDPOINT = 'https://www.colisweb.com/api/search';
const TIMEZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 500_000;
const NOT_FOUND_PATTERN = /not[ -]?found|introuvable|inconnu/i;
/** The stages during which the tracking page shows the booked slot. */
const PLANNED_STAGES: ReadonlySet<Stage> = new Set(['registered', 'in_transit', 'out_for_delivery']);

/**
 * The endpoint sends ISO 8601 timestamps with their own offset, so they are kept
 * verbatim rather than restamped. Anything `Date.parse` refuses is dropped.
 */
function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = clean(value, 64);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : null;
}

function writtenDay(value: unknown): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(clean(value, 64));
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * The booked slot as the tracking page shows it: the day it starts, then
 * `HH:mm–HH:mm`. The endpoint sends UTC instants and the page prints them on
 * French clocks, so they are restated on Paris time. A slot whose end is
 * missing, not after its start or on another day keeps only its day, and one
 * without an offset the day it is written with. A slot that ended before the
 * newest milestone is dropped.
 */
function bookedSlot(startsAt: unknown, endsAt: unknown, newest: number): string | null {
  const start = explicitOffsetTime(startsAt);
  if (!start) return writtenDay(startsAt);
  const end = explicitOffsetTime(endsAt);
  if ((end ?? start).timestamp < newest) return null;
  const clock = (time: ParsedTime) => DateTime.fromMillis(time.timestamp, { zone: TIMEZONE }).toFormat('yyyy-MM-dd HH:mm');
  const first = clock(start);
  const last = end ? clock(end) : '';
  return last.slice(0, 10) === first.slice(0, 10) && first < last
    ? `${first}–${last.slice(11)}`
    : first.slice(0, 10);
}

function saysNotFound(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const text = [value.error, value.message, value.texteErreur]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return /not[ -]?found|introuvable|inconnu|aucun(?:e)? livraison/i.test(text);
}

export function normalizeColiswebTrackingNumber(raw: string): string {
  const value = raw.replace(/\s/g, '');
  if (!/^\d{8,32}$/.test(value)) {
    throw new InvalidInputError(PROVIDER, 'Colisweb tracking numbers must contain at least 8 digits');
  }
  return value;
}

export function coliswebTrackingUrl(): string {
  return TRACKING_ENDPOINT;
}

export function coliswebRequestBody(rawTrackingNumber: string): string {
  return JSON.stringify({ value: normalizeColiswebTrackingNumber(rawTrackingNumber) });
}

export function parseColiswebTrackingResponse(
  payload: unknown,
  rawTrackingNumber: string,
): CarrierResult {
  const trackingNumber = normalizeColiswebTrackingNumber(rawTrackingNumber);
  if (saysNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Colisweb returned an invalid tracking response');

  const responseNumber = typeof payload.searchValue === 'string'
    ? payload.searchValue.replace(/\s/g, '')
    : '';
  if (!/^\d{8,32}$/.test(responseNumber)) {
    throw new SchemaError(PROVIDER, 'Colisweb returned incomplete tracking details');
  }
  if (responseNumber !== trackingNumber) {
    throw new SchemaError(PROVIDER, 'Colisweb returned a different shipment');
  }

  const current = classifyStatus(payload.step);
  const milestones: Array<{ value: unknown; classified: ClassifiedStatus }> = [
    {
      value: payload.deliveredDate,
      classified: classifyStatus('delivered'),
    },
    {
      value: payload.pickedUpDate,
      classified: classifyStatus('pickedUp'),
    },
    {
      value: payload.deliveryConfirmationDate,
      classified: classifyStatus('confirmed'),
    },
  ];
  const events: CarrierEvent[] = milestones.flatMap(({ value, classified }) => {
    const time = normalizedTimestamp(value);
    return time ? [{ time, description: classified.description, stage: classified.stage }] : [];
  });
  if (!events.some((event) => event.stage === current.stage)) {
    // An unmapped step carries no stage, so the sync classifies this entry.
    events.unshift({
      description: current.description,
      ...(current.stage ? { stage: current.stage } : {}),
    });
  }
  const lastUpdate = events.find((event) => event.time)?.time ?? null;
  const newest = Math.max(-Infinity, ...events.map((event) => explicitOffsetTime(event.time)?.timestamp ?? -Infinity));
  // The page replaces the slot with a message once the delivery is being rescheduled.
  const planned = current.stage !== undefined && PLANNED_STAGES.has(current.stage)
    && payload.haveReschedule !== true && payload.inRescheduleProcess !== true;
  const sender = clean(payload.clientName, 120);

  return {
    status: current.status,
    ...(current.stage ? { current_stage: current.stage } : {}),
    last_status_text: current.description,
    last_update: lastUpdate,
    expected_delivery: planned ? bookedSlot(payload.startsAt, payload.endsAt, newest) : null,
    ...(sender ? { sender_name: sender } : {}),
    timezone: TIMEZONE,
    events,
  };
}

export interface ColiswebTrackerOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class ColiswebTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: ColiswebTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Colisweb timeout must be positive');
    }
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeColiswebTrackingNumber(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { response, bytes } = await fetchBounded(coliswebTrackingUrl(), {
      method: 'POST',
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://www.colisweb.com',
        Referer: 'https://www.colisweb.com/suivi-livraison',
        'User-Agent': this.#userAgent,
      },
      body: coliswebRequestBody(trackingNumber),
    }, {
      provider: 'Colisweb tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'error',
      allowHttpError: true,
      fetcher: this.#fetcher,
    });

    if ([400, 404, 422].includes(response.status)) throw new NotFoundError(PROVIDER);
    if (response.status === 500 && bytes.byteLength === 0) {
      // The official UI turns this empty HTTP 500 into its not-found card, but the
      // response itself proves nothing: reporting it as a 404 would invent a fact.
      throw new IndeterminateError(
        PROVIDER,
        'Colisweb returned an empty HTTP 500 for the shipment lookup',
      );
    }
    if (!response.ok) {
      if (NOT_FOUND_PATTERN.test(decodeText(bytes))) throw new NotFoundError(PROVIDER);
      throw new UpstreamHttpError('Colisweb tracking', response.status);
    }
    return parseColiswebTrackingResponse(
      parseJsonBytes(bytes, 'Colisweb tracking'),
      trackingNumber,
    );
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ColiswebTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'colisweb',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
