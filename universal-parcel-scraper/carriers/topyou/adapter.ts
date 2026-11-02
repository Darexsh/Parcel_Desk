import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { isNetworkFailure } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, trawlBody, type TrawlClient } from '../../core/transport/trawl.js';
import { normalizeTopyouNumber, parseTopyou, PROVIDER, TOPYOU_MAX_BYTES } from './parser.js';

/** The lookup TopYou's tracker at track.szty56.com makes for the numbers typed in. */
export const TOPYOU_API = 'https://track.szty56.com/order/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TopYou answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'TopYou returned a reply that is not JSON', { cause });
  }
}

export class TopyouTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTopyouNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(TOPYOU_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ ids: [number] }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: TOPYOU_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TopYou redirected its tracking lookup');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'TopYou refused the lookup', { status: 403 });
      if (!response.ok) throw new TransportError(PROVIDER, 'TopYou tracking lookup is unavailable', { status: response.status });
      return parseTopyou(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'topyou', budgetMs: context.budgetMs ?? (this.options.trawl ? 45_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, Math.min(15_000, remainingMs)) },
      { id: 'trawl', enabled: Boolean(this.options.trawl),
        recovers: error => isNetworkFailure(error) || carrierErrorKind(error) === 'challenge',
        run: async ({ signal, remainingMs }) => {
          const timeoutMs = Math.floor(Math.min(12_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
          if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
          // This alternative HTTP stack can reach TopYou after a refused local
          // connection. No browser or CAPTCHA solver is launched.
          const response = await this.options.trawl!.scrape({ url: TOPYOU_API, method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
            body: JSON.stringify({ ids: [number] }), maxTier: 1, maxTimeout: timeoutMs,
          }, { provider: PROVIDER, signal, timeoutMs, requireSolved: false,
            fetcher: this.options.fetcher, maxBytes: TOPYOU_MAX_BYTES * 8 + 65_536 }).catch((error: unknown) => {
            if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
              throw new TransportError(PROVIDER, 'TopYou tracking lookup is unavailable', { status: error.status, cause: error });
            }
            throw error;
          });
          signal.throwIfAborted();
          if (response.url !== TOPYOU_API || response.statusCode !== 200 || response.tier !== 1) {
            throw new TransportError(PROVIDER, 'TopYou remote lookup did not return the requested HTTP response');
          }
          const body = trawlBody(response.raw, TOPYOU_MAX_BYTES) || response.html;
          if (new TextEncoder().encode(body).byteLength > TOPYOU_MAX_BYTES) throw new SchemaError(PROVIDER, 'TopYou returned excessive tracking data');
          return parseTopyou(json(body), number);
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TopyouTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new TopyouTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'topyou', recordsSteps: true, steps: ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeTopyouNumber(number))),
  };
};
