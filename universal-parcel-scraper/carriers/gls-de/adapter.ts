
import { lookupBudget, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { cleanScalar, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  GLS_DETAIL_NOT_FOUND,
  GLS_OVERVIEW_NOT_FOUND,
  GLS_POSTCODE_MISMATCH,
  glsLastError,
  glsPostcodeMismatch,
  glsSwitzerlandDetailApiUrl,
  glsDeliveryReference,
  glsSwitzerlandOverviewApiUrl,
  GLSSwitzerlandTrackingError,
  normalizeGLSSwitzerlandPostcode,
  normalizeGLSSwitzerlandTrackingNumber,
  parseGLSSwitzerlandTrackingResponse,
  selectGLSParcel,
} from '../gls-ch/adapter.js';

// GLS's GROUP recipient service covers the parcels GLS delivers across its
// network, so the delivery postcode can be any country's. Keep the shared
// response parser.
const PROVIDER = 'GLS Germany tracking';
const CARRIER = 'GLS Germany';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GLSGermanyOptions {
  timeoutMs?: number;
  now?: () => number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

/** Kept as a named class: the host's grouped live suite asserts this error's name. */
export class GLSGermanyTrackingError extends NotFoundError {
  constructor() {
    super(CARRIER);
    this.name = 'GLSGermanyTrackingError';
  }
}

export class GLSGermanyTracker {
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | GLSGermanyOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, now: Date.now, fetcher: undefined, userAgent: undefined }
      : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('GLS Germany timeout must be positive');
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(rawTrackingNumber: string, rawPostcode: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
    const postcode = normalizeGLSSwitzerlandPostcode(rawPostcode, 'any');
    // Two requests, each with the full request timeout.
    const budget = lookupBudget(context, 2 * this.timeoutMs);
    const overview = await this.request(glsSwitzerlandOverviewApiUrl(number, this.now()), budget);
    // Validate the overview identity before resolving a Track ID to a parcel number.
    try {
      parseGLSSwitzerlandTrackingResponse(overview, number);
    } catch (error) {
      if (error instanceof GLSSwitzerlandTrackingError) throw new GLSGermanyTrackingError();
      throw error;
    }
    if (!isRecord(overview) || !Array.isArray(overview.tuStatus)) {
      throw new SchemaError(CARRIER, 'GLS Germany returned an invalid overview');
    }
    const parcel = selectGLSParcel(overview, number);
    if (!parcel || !/^\d{11,14}$/.test(String(parcel.tuNo))) {
      throw new SchemaError(CARRIER, 'GLS Germany did not return a numeric parcel number');
    }
    const owners = Array.isArray(parcel.owners) ? parcel.owners.filter(isRecord) : [];
    const owner = owners.find((row) => row.type === 'REQUEST');
    const detail = await this.request(glsSwitzerlandDetailApiUrl(
      String(parcel.tuNo), postcode, this.now(), cleanScalar(owner?.code, 64), 'any',
    ), budget, true);
    try {
      const result = parseGLSSwitzerlandTrackingResponse(detail, String(parcel.tuNo));
      // Both services use CET/CEST; expose the regional timezone to clients.
      return { ...result, ...glsDeliveryReference(parseGLSSwitzerlandTrackingResponse(overview, number)), timezone: 'Europe/Berlin' };
    } catch (error) {
      if (error instanceof GLSSwitzerlandTrackingError) throw new GLSGermanyTrackingError();
      throw error;
    }
  }

  /**
   * Whether GLS Germany itself recognizes an ambiguous numeric shape. Used by
   * the host's carrier-detection route, which promotes a number to `gls-de`
   * only after this returns true; a provider failure must stay a failure.
   */
  async recognizes(rawTrackingNumber: string, context: TrackingContext = {}): Promise<boolean> {
    const number = normalizeGLSSwitzerlandTrackingNumber(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    try {
      const url = glsSwitzerlandOverviewApiUrl(number, this.now()).replace('/GROUP/en/', '/DE/en/');
      const overview = await this.request(url, budget);
      const result = parseGLSSwitzerlandTrackingResponse(overview, number);
      return result.status !== 'unknown';
    } catch (error) {
      if (error instanceof GLSGermanyTrackingError || error instanceof GLSSwitzerlandTrackingError) return false;
      throw error;
    }
  }

  /**
   * A request that fails to reach GLS, or hangs, is sent once more: the first gets at most half of
   * what is left, so the second fits in the rest.
   */
  private async request(url: string, budget: LookupBudget, detail = false): Promise<unknown> {
    const { response, bytes } = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(url, {
      signal: budget.signal,
      headers: { Accept: 'application/json', Referer: 'https://gls-group.eu/EU/en/parcel-tracking', 'User-Agent': this.#userAgent },
    }, {
      provider: PROVIDER,
      timeoutMs: Math.min(this.timeoutMs, timeoutMs),
      maxBytes: 1_000_000,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    }));
    // A challenge, rate limit or outage must not become "not found". GLS's own 404 for an expired
    // or unknown parcel does. On the detail request, its 404 for a postcode that does not match the
    // parcel the overview found asks for the postcode again, as on GLS Switzerland. Any other 404 is
    // inconclusive, since an HTTP error with that status would read as not found; other statuses
    // stay upstream errors.
    if (response.status === 404) {
      if ((detail ? GLS_DETAIL_NOT_FOUND : GLS_OVERVIEW_NOT_FOUND).includes(glsLastError(bytes))) throw new GLSGermanyTrackingError();
      if (detail && GLS_POSTCODE_MISMATCH.includes(glsLastError(bytes))) throw glsPostcodeMismatch(CARRIER);
      throw new IndeterminateError(PROVIDER, 'GLS returned HTTP 404 without its own not-found reply', { status: 404 });
    }
    if (!response.ok) throw new UpstreamHttpError(PROVIDER, response.status);
    return parseJsonBytes(bytes, PROVIDER);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSGermanyTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'gls-de',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
