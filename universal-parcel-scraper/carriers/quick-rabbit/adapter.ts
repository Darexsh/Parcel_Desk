import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isUnknownCode, normalizeQuickRabbitCode, parseQuickRabbit, PROVIDER, QUICK_RABBIT_MAX_BYTES } from './parser.js';

/** The lookup Quick Rabbit's tracking page makes for one code. */
export const QUICK_RABBIT_TRACKING_API = 'https://api.tms.quickrabbit.es/api/v1/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one code. */
export function quickRabbitTrackingUrl(code: string): string {
  return `${QUICK_RABBIT_TRACKING_API}${encodeURIComponent(code)}/`;
}

/** The wait the tracker's reset header names, in seconds, when it names one. */
function resetMs(header: string | null): number | undefined {
  const seconds = header && /^\d{1,4}$/.test(header.trim()) ? Number(header.trim()) : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Quick Rabbit answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Quick Rabbit returned a reply that is not JSON', { cause });
  }
}

export class QuickRabbitTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(code: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(quickRabbitTrackingUrl(code), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: QUICK_RABBIT_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429] });
    const { status } = response;
    // It counts each address's lookups a minute and says in how many seconds the count starts again.
    if (status === 429) {
      throw new RateLimitedError(PROVIDER, resetMs(response.headers.get('x-ratelimit-reset')), 'Quick Rabbit refused more lookups for now', { status });
    }
    if (status === 403) throw new ChallengeError(PROVIDER, 'Quick Rabbit refused the lookup', { status });
    if (status === 404) {
      // The tracker says "Package not found" for a code it does not know; any other 404 is a moved route.
      let payload: unknown;
      try {
        payload = JSON.parse(decodeText(bytes));
      } catch {
        payload = undefined;
      }
      if (isUnknownCode(payload)) return parseQuickRabbit(payload, code);
    }
    if (REDIRECTS.includes(status) || status === 404 || status === 410) {
      throw new TransportError(PROVIDER, 'Quick Rabbit tracking lookup is unavailable', { status });
    }
    return parseQuickRabbit(json(decodeText(bytes)), code);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const code = normalizeQuickRabbitCode(raw);
    // A read that fails to reach Quick Rabbit, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(code, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(code, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QuickRabbitTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeQuickRabbitCode(number))),
  };
};
