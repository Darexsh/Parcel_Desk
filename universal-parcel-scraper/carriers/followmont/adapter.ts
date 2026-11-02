import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, FOLLOWMONT_MAX_BYTES, followmontBookingWindow, normalizeFollowmontNumber, parseFollowmontBooking, parseFollowmontTrace, PROVIDER,
} from './parser.js';

// The Track & Trace page's Visual Builder proxy to Followmont's integration flows, as the page addresses it.
const FLOWS = 'https://www.followmont.com.au/ic/builder/rt/followmont_master/live;profile=development/services/auth/1.1/proxy/'
  + 'oracleIntegrationCloud/uri/https/prodfollowmontoic-followmontintegration-sy.integration.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest';
/** The freight system's trace the page asks for a number its bookings search does not find. */
export const FOLLOWMONT_TRACE_API = `${FLOWS}/RETR_MISS_CONS_DATA___TM/1.0/Trace`;
/** The bookings search the page asks first, for consignments picked up in the past month. */
export const FOLLOWMONT_BOOKING_API = `${FLOWS}/RETRI_CONSI_DATA___OEC/1.0/TraceUnsecured`;
const REDIRECTS = [301, 302, 303, 307, 308];
// Both flows answer every number with HTTP 200: a missing route is not a missing consignment.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|_Incapsula_Resource|captcha/i;

export class FollowmontTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  private async post(url: string, body: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify(body) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FOLLOWMONT_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    const status = response.status;
    if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Followmont tracking lookup is unavailable', { status });
    const text = decodeText(bytes);
    try {
      return JSON.parse(text);
    } catch (cause) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Followmont answered with a browser check', { cause });
      throw new SchemaError(PROVIDER, 'Followmont returned a reply that is not JSON', { cause });
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFollowmontNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, deadline - performance.now());
      const traced = parseFollowmontTrace(await this.post(FOLLOWMONT_TRACE_API, { ConsignmentIDs: number }, signal, left()), number);
      if (traced) return traced;
      // The freight system holds no consignment under the number: a booking it has not received yet can.
      const window = followmontBookingWindow((this.options.now ?? Date.now)());
      return parseFollowmontBooking(await this.post(FOLLOWMONT_BOOKING_API, { ConID: number, ...window }, signal, left()), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FollowmontTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
