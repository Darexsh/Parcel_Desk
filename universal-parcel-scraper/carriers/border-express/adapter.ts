import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { borderExpressNumber } from './number.js';
import { BORDER_EXPRESS_MAX_BYTES, CARRIER, parseBorderExpress, PROVIDER } from './parser.js';

/** The request BEX Online's Quick Track makes first; its id goes with the lookup that follows. */
export const BORDER_EXPRESS_VERIFICATION = 'https://bexonlineapi.borderexpress.com.au/v1/consignments/quicktrackverification';
/** Quick Track's lookup of one consignment. */
export const BORDER_EXPRESS_LOOKUP = 'https://bexonlineapi.borderexpress.com.au/v2/consignments/quickTrackpublic';
// The service refuses a request that does not name the application, as Quick Track does.
const APPLICATION = 'bexonline';
const VERIFICATION_MAX_BYTES = 16 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const VERIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The cookie the verification sets beside its id.
const VERIFICATION_COOKIE = /^qt-verification=[A-Za-z0-9._~+/=-]{8,2048}$/;
// Bot checks a CDN or firewall could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|challenge-platform|captcha/i;

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `Border Express answered its ${what} with a browser check`, { cause });
    throw new SchemaError(PROVIDER, `Border Express returned a ${what} that is not JSON`, { cause });
  }
}

/** The ASP.NET problem reply Quick Track reads as "We could not find your consignment". */
function isMissingConsignment(body: string): boolean {
  try {
    const problem: unknown = JSON.parse(body);
    return isRecord(problem) && problem.status === 404 && problem.title === 'Not Found';
  } catch {
    return false;
  }
}

export class BorderExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { consignment, barcode } = borderExpressNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The verification and the lookup share the attempt's time.
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const verification = await fetchBounded(BORDER_EXPRESS_VERIFICATION, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgent, 'bex-application-name': APPLICATION,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: VERIFICATION_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (verification.response.status !== 200) {
        throw new TransportError(PROVIDER, 'Border Express Quick Track verification is unavailable', { status: verification.response.status });
      }
      const verified = json(decodeText(verification.bytes), 'Quick Track verification');
      const id = isRecord(verified) && typeof verified.verificationId === 'string' ? verified.verificationId : '';
      if (!VERIFICATION_ID.test(id)) throw new SchemaError(PROVIDER, 'Border Express returned no Quick Track verification');
      const cookie = verification.response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim())
        .find((part) => VERIFICATION_COOKIE.test(part));

      const { response, bytes } = await fetchBounded(`${BORDER_EXPRESS_LOOKUP}?consignmentNumber=${encodeURIComponent(consignment)}`, {
        method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgent, 'bex-application-name': APPLICATION, 'x-qt-verification': id,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, { provider: PROVIDER, timeoutMs: left(), maxBytes: BORDER_EXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE] });
      const body = decodeText(bytes);
      if (response.status === 404 && isMissingConsignment(body)) {
        // The tracker does not take a barcode: a consignment it was read into
        // that is missing may be one whose range has another length.
        if (barcode) throw new IndeterminateError(PROVIDER, 'Border Express has no consignment for the barcode\'s reading', { reason: 'portal_not_found' });
        throw new NotFoundError(PROVIDER);
      }
      // A route the service no longer has answers 404 without the problem reply.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Border Express Quick Track lookup is unavailable', { status: response.status });
      return parseBorderExpress(json(body, 'Quick Track lookup'), raw);
    };
    // A verification or lookup that fails to reach Border Express, or hangs,
    // gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BorderExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
