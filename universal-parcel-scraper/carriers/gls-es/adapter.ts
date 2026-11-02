import { createHmac } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeGLSSpainNumber, normalizeGLSSpainPostcode, parseGLSSpainReply, PROVIDER } from './parser.js';

// The service mygls.gls-spain.es asks for a shipment by number and delivery postcode.
export const GLS_SPAIN_ENDPOINT = 'https://api.consignee.gls-spain.es/api/v5/expeditions/find';
// The path the signature covers, without the API's prefix.
const SIGNED_PATH = '/expeditions/find';
// Shared request-signing secret the tracking page receives from Remote Config, distributed with the maintainer's approval.
export const GLS_SPAIN_SIGNING_SECRET = 'gls';
// A shipment reply is a few kilobytes.
const MAX_BYTES = 512 * 1024;
// A bot check or a block page instead of the service's JSON.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>[^<]*(?:just a moment|attention required|access denied)/i;

/** The page's X-Signature: hex HMAC-SHA256 of the method, the path and the X-Timestamp, one per line. */
export function glsSpainSignature(timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`POST\n${SIGNED_PATH}\n${timestamp}`, 'utf8').digest('hex');
}

/** The lookup's body: the number and the postcode, as the page sends them. */
export function glsSpainLookupBody(number: string, postcode: string): string {
  return JSON.stringify({ find: { reference: number, destination: { address: { postalCode: postcode } } } });
}

export class GLSSpainTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder;
    userAgent?: string; now?: () => Date } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGLSSpainNumber(raw);
    const postcode = normalizeGLSSpainPostcode(rawPostcode);
    const body = glsSpainLookupBody(number, postcode);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The service refuses a timestamp minutes away from its clock, so each try signs anew.
      const timestamp = (this.options.now?.() ?? new Date()).toISOString();
      const { response, bytes } = await fetchBounded(GLS_SPAIN_ENDPOINT, { method: 'POST', body, signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en_US', 'Content-Type': 'application/json; charset=utf-8',
        'MyGls-Agent': 'pwa', 'X-Timestamp': timestamp, 'X-Signature': glsSpainSignature(timestamp, GLS_SPAIN_SIGNING_SECRET),
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES,
        allowHttpStatuses: [404], fetcher: this.options.fetcher });
      const head = decodeText(bytes.subarray(0, 4_096));
      if (/^\s*</.test(head)) {
        if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'GLS Spain asked for a browser check');
        throw new IndeterminateError(PROVIDER, 'GLS Spain answered with a web page instead of tracking data');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); } catch (cause) {
        throw new SchemaError(PROVIDER, 'GLS Spain returned invalid tracking JSON', { cause });
      }
      return parseGLSSpainReply(response.status, payload, number);
    };
    // A request that fails to reach GLS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gls-es', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSSpainTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // The postcode is part of every lookup, so the adapter cannot recognize a number alone.
  return {
    id: 'gls-es', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
