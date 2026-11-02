import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizePcpExpressNumber, parsePcpExpress, PCP_EXPRESS_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup the tracking results page on pcpexpress.com makes for the numbers typed in. */
export const PCP_EXPRESS_API = 'https://www.pcpexpress.com/apps/RequestTracking.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker refuses a lookup, an unknown number included, with HTTP 500 and its message:
// a 404 is a moved route.
const GONE = [404, 410];
// Bot checks a CDN or the host's web server could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|hcaptcha|\.lsrecap\//i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PCP Express answered with a browser check', { cause });
    if (status === 500) throw new IndeterminateError(PROVIDER, 'PCP Express could not complete the lookup', { status, cause });
    throw new SchemaError(PROVIDER, 'PCP Express returned a reply that is not JSON', { cause });
  }
}

export class PcpExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page posts the numbers typed in as one JSON string, separated by commas; this is one AWB.
    const { response, bytes } = await fetchBounded(PCP_EXPRESS_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PCP_EXPRESS_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 500] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PCP Express redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PCP Express tracking lookup is unavailable', { status: response.status });
    const payload = json(decodeText(bytes), response.status);
    // A shipment is never an HTTP 500.
    if (response.status === 500 && !(isRecord(payload) && payload.status === false)) {
      throw new IndeterminateError(PROVIDER, 'PCP Express could not complete the lookup', { status: 500 });
    }
    return parsePcpExpress(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePcpExpressNumber(raw);
    // A read that fails to reach PCP Express, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'pcp-express', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PcpExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pcp-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePcpExpressNumber(number))),
  };
};
