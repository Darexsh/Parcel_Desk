import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { Recognition } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeEvriUkNumber, parseEvriUk } from './parser.js';

export const EVRI_UK_MOBILE_API = 'https://tracking.platform-apis.evri.com/v1';
/** The history service answered and confirmed no domestic parcel activity; the page asks the same service. */
export const EVRI_UK_UNCONFIRMED = 'parcel_unconfirmed';
const MAX_BYTES = 2_000_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = 'NpxtibhIgliySB4JRfjAQq2vytmiWGUQ';

function unconfirmed(): never {
  throw new IndeterminateError('Evri UK', 'Evri UK could not confirm a domestic parcel', { reason: EVRI_UK_UNCONFIRMED });
}

type MobileOptions = { fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number };

async function request(url: URL, options: MobileOptions, deadline: number): Promise<{ status: number; payload: unknown }> {
  const { response, bytes } = await fetchBounded(url, { signal: options.signal,
    headers: { Accept: 'application/json', apiKey: APPLICATION_KEY, 'User-Agent': userAgentOf(options.userAgent) } }, {
    provider: 'Evri UK', maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
    fetcher: options.fetcher, allowHttpStatuses: [400, 401, 403, 404, 410],
  });
  if ([401, 403].includes(response.status)) throw new ChallengeError('Evri UK', 'Evri UK refused the tracking API key');
  let payload: unknown;
  try { payload = JSON.parse(decodeText(bytes)); } catch { payload = undefined; }
  // The service reports a reference it rejects as JSON; a bare status is the endpoint's.
  if (response.status !== 200 && !(isRecord(payload) && Array.isArray(payload.errors) && payload.errors.length)) {
    if ([404, 410].includes(response.status)) throw new TransportError('Evri UK', 'Evri UK tracking API is unavailable', { status: response.status });
    throw new UpstreamHttpError('Evri UK', response.status);
  }
  if (response.status === 200 && payload === undefined) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking data');
  return { status: response.status, payload };
}

async function guarded<T>(options: MobileOptions, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    options.signal.throwIfAborted();
    // Transport diagnostics include the key, the barcode and recipient fields.
    // Preserve the failure contract without forwarding request or body data.
    if (error instanceof CarrierError) throw new CarrierError(error.kind, 'Evri UK', `Evri UK tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
    throw new TransportError('Evri UK', 'Evri UK tracking API request failed');
  }
}

function boundUrn(identifier: unknown, number: string): string {
  const urn = isRecord(identifier) ? identifier.urn : undefined;
  if (typeof urn !== 'string' || !new RegExp(`^urn:parcel_id:barcode:date:\\d{1,30}:${number}:\\d{4}-\\d{2}-\\d{2}$`).test(urn)) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
  }
  return urn;
}

function identifiersOf(payload: unknown): unknown[] {
  const identifiers = isRecord(payload) ? payload.parcelIdentifiers : undefined;
  if (!Array.isArray(identifiers) || identifiers.length > 50) throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel identifiers');
  return identifiers;
}

export function readEvriUkMobile(raw: string, options: MobileOptions): Promise<CarrierResult> {
  const number = normalizeEvriUkNumber(raw);
  const deadline = performance.now() + options.timeoutMs;
  return guarded(options, async () => {
    const reference = await request(new URL(`${EVRI_UK_MOBILE_API}/parcels/reference/${number}`), options, deadline);
    if (reference.status !== 200) unconfirmed();
    const identifiers = identifiersOf(reference.payload);
    // Several parcels or an international redirect do not settle one domestic parcel.
    const identifier: unknown = identifiers.length === 1 ? identifiers[0] : undefined;
    if (identifiers.length !== 1 || (isRecord(identifier) && identifier.redirectUrl)) unconfirmed();
    const urn = boundUrn(identifier, number);
    const endpoint = new URL(`${EVRI_UK_MOBILE_API}/parcels/`);
    endpoint.searchParams.set('uniqueIds', urn);
    const history = await request(endpoint, options, deadline);
    if (history.status !== 200) unconfirmed();
    try { return parseEvriUk(history.payload, number, urn); }
    catch (error) { if (error instanceof IndeterminateError) unconfirmed(); throw error; }
  });
}

/**
 * Whether Evri UK holds the barcode, from the reference lookup tracking starts
 * with. No parcel and a barcode the service rejects for its check digit are
 * unknown, and so is a parcel it redirects to Evri International's tracker.
 */
export function recognizeEvriUkMobile(raw: string, options: MobileOptions): Promise<Recognition> {
  const number = normalizeEvriUkNumber(raw);
  const deadline = performance.now() + options.timeoutMs;
  return guarded(options, async () => {
    const reference = await request(new URL(`${EVRI_UK_MOBILE_API}/parcels/reference/${number}`), options, deadline);
    if (reference.status !== 200) {
      const errors = isRecord(reference.payload) && Array.isArray(reference.payload.errors) ? reference.payload.errors : [];
      if (reference.status === 400 && errors.length === 1 && isRecord(errors[0]) && errors[0].errorType === 'InvalidReferenceException') return { known: false };
      throw new IndeterminateError('Evri UK', 'Evri UK could not say whether it holds the parcel');
    }
    const identifiers = identifiersOf(reference.payload);
    if (!identifiers.length) return { known: false };
    if (identifiers.length > 1) throw new IndeterminateError('Evri UK', 'Evri UK holds several parcels under the barcode');
    if (isRecord(identifiers[0]) && identifiers[0].redirectUrl) return { known: false };
    boundUrn(identifiers[0], number);
    return { known: true, lastActivityAt: null };
  });
}
