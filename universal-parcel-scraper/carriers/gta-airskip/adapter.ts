import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GTA_AIRSKIP_MAX_BYTES, normalizeGtaAirskipNumber, parseGtaAirskip, PROVIDER } from './parser.js';

/** The lookup the tracking page on gtaairskip.com makes for the numbers in its address or field. */
export const GTA_AIRSKIP_API = 'https://tms-api.gtagsm.com/trackings/track-my-package';
// The account name the page's configuration sends with every lookup.
const ACCOUNT = 'Portal';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown number with an empty list: a 404 is a moved route.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|hcaptcha|AwsWafIntegration|awswaf\.com/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GTA AirSkip answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GTA AirSkip returned a reply that is not JSON', { cause });
  }
}

export class GtaAirskipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page asks for up to thirty numbers at once, with their history; this is one.
    const { response, bytes } = await fetchBounded(GTA_AIRSKIP_API, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'x-account-key': ACCOUNT,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ PageSize: 1, Page: 1, TrackingNumbers: [number], DateFilterType: 0, IncludeHistory: true }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GTA_AIRSKIP_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE],
    });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GTA AirSkip redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'GTA AirSkip tracking lookup is unavailable', { status: response.status });
    return parseGtaAirskip(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGtaAirskipNumber(raw);
    // A read that fails to reach GTA AirSkip, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'gta-airskip', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GtaAirskipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gta-airskip', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGtaAirskipNumber(number))),
  };
};
