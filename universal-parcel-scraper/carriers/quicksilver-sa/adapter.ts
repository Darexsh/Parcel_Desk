import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isQuicksilverUnknown, normalizeQuicksilverNumber, parseQuicksilver, PROVIDER, QUICKSILVER_MAX_BYTES } from './parser.js';

/** The history lookup the tracking page on quick-silver.express makes for the number typed in. */
export const QUICKSILVER_HISTORY_API = 'https://erp.quick-silver.express/v1/customer/tracking/history';
// The bearer token the tracking page's script sends with every lookup, the same for every visitor.
const PAGE_TOKEN = 'ZcJah81NgGDsZXnm9KJlGMEFiKCep5jDf1Q24_wnICE'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|captcha/i;

/** The history lookup for one number, as the tracking page sends it. */
export function quicksilverLookupUrl(raw: string): string {
  return `${QUICKSILVER_HISTORY_API}?${new URLSearchParams({ tracking_number: normalizeQuicksilverNumber(raw) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Quicksilver answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Quicksilver returned a reply that is not JSON', { cause });
  }
}

/** The service's answer for an unknown number, or null for any other reply. */
function unknownReply(body: string): unknown {
  try {
    const payload: unknown = JSON.parse(body);
    return isQuicksilverUnknown(payload) ? payload : null;
  } catch {
    return null;
  }
}

export class QuicksilverTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeQuicksilverNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(quicksilverLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', Authorization: `Bearer ${PAGE_TOKEN}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: QUICKSILVER_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410] });
      const status = response.status;
      if (REDIRECTS.includes(status) || status === 410) throw new TransportError(PROVIDER, 'Quicksilver tracking lookup is unavailable', { status });
      // A missing or refused token is HTTP 401, which no number changes.
      if (status === 401) throw new ChallengeError(PROVIDER, 'Quicksilver refused the tracking page\'s token', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Quicksilver refused the lookup', { status });
      // HTTP 404 carries the service's answer for an unknown number; another is a moved route.
      if (status === 404) {
        const payload = unknownReply(decodeText(bytes));
        if (!payload) throw new TransportError(PROVIDER, 'Quicksilver tracking lookup is unavailable', { status });
        return parseQuicksilver(payload, number);
      }
      // HTTP 400 refuses the request itself: the page reads it as an empty field.
      if (status === 400) throw new SchemaError(PROVIDER, 'Quicksilver refused the lookup', { status });
      return parseQuicksilver(json(decodeText(bytes)), number);
    };
    // A request that fails to reach Quicksilver, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QuicksilverTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
