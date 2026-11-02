import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LINEAR_MAX_BYTES, normalizeLinearNumber, parseLinear, PROVIDER } from './parser.js';

/** The anonymous lookup the current public tracking page calls. */
export const LINEAR_API = 'https://linearlogistics.co.uk/tracking/lookup';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

export function linearLookupUrl(raw: string): string {
  return `${LINEAR_API}?${new URLSearchParams({ q: normalizeLinearNumber(raw) })}`;
}

/** Tracking URLs and response excerpts can contain the number or delivery details. */
function privateFailure(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  // Retain the failure class the retry reads, without the client's URL or cause text.
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, new Error('Linear Logistics tracking request failed'));
  return error;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Linear Logistics answered with a browser check');
    // A JSON parser's cause can quote a recipient or a capability URL.
    throw new SchemaError(PROVIDER, 'Linear Logistics returned a reply that is not JSON');
  }
}

export class LinearTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLinearNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let response: Response;
      let bytes: Uint8Array;
      try {
        ({ response, bytes } = await fetchBounded(linearLookupUrl(number), { method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
          maxBytes: LINEAR_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] }));
      } catch (error) {
        throw privateFailure(error);
      }
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Linear Logistics redirected its tracking lookup');
      // Unknown numbers have a JSON notice on HTTP 200; these statuses mean the route moved.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Linear Logistics tracking lookup is unavailable');
      return parseLinear(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'linear-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LinearTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'linear-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
