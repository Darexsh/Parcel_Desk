import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DX_MAX_BYTES, normalizeDxNumber, normalizeDxPostcode, parseDxFreight, parseDxLookupPage, PROVIDER } from './parser.js';

const ORIGIN = 'https://dx-track.com';
/** Where DX's tracking page sends a freight consignment and its delivery postcode. */
export const DX_FREIGHT_LOOKUP = `${ORIGIN}/track/dx.aspx`;
/** The pages of the session the lookup opens: its menu, and the history the menu's button opens. */
const MENU = '/track/Menu.aspx';
const HISTORY = '/track/Track.aspx';
/** The notice the tracker redirects to for an unknown number, a wrong postcode, an old delivery or a lost session. */
const NOTICE = '/track/TrackingError.aspx';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/**
 * The lookup's address, as DX's tracking page builds it. The postcode keeps its
 * space as `%20`: the tracker matches a `+` against no postcode.
 */
export function dxFreightUrl(raw: string, rawPostcode: string | null | undefined): string {
  return `${DX_FREIGHT_LOOKUP}?consno=${encodeURIComponent(normalizeDxNumber(raw))}&postcode=${encodeURIComponent(normalizeDxPostcode(rawPostcode))}`;
}

/** The same failure without the request and response details fetchBounded attaches: the address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

/** The ASP.NET session the lookup opened; its pages are bound to it. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const match = /^ASP\.NET_SessionId=([A-Za-z0-9]{8,64})(?:;|$)/.exec(header);
    if (match) return `ASP.NET_SessionId=${match[1]}`;
  }
  throw new IndeterminateError(PROVIDER, 'DX did not open a session for the lookup', { reason: 'session_rejected' });
}

/** The tracker's page a redirect points to, on its own host. */
function redirectPath(response: Response): string {
  const location = response.headers.get('location');
  if (!location || location.length > 2_000) throw new SchemaError(PROVIDER, 'DX returned an incomplete redirect');
  let url: URL;
  try { url = new URL(location, DX_FREIGHT_LOOKUP); } catch { throw new SchemaError(PROVIDER, 'DX returned an invalid redirect'); }
  if (url.origin !== ORIGIN || url.search || url.hash) throw new SchemaError(PROVIDER, 'DX redirected the lookup to an unexpected address');
  return url.pathname;
}

export class DxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDxNumber(raw);
    // Without the postcode the tracker shows nothing, so no request is made.
    const url = dxFreightUrl(number, rawPostcode);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const request = async (address: string, cookie?: string) => {
        const result = await fetchBounded(address, { method: 'GET', signal, headers: {
          Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent), ...(cookie ? { Cookie: cookie } : {}),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: DX_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
        if (result.response.status === 403) throw new ChallengeError(PROVIDER, 'DX refused the lookup', { status: 403 });
        if (GONE.includes(result.response.status)) throw new TransportError(PROVIDER, 'DX Freight tracking is unavailable', { status: result.response.status });
        return result;
      };
      // The lookup DX's tracking page sends the browser to. It opens a session
      // and redirects to the menu, or to the tracker's notice.
      let lookup: Awaited<ReturnType<typeof request>>;
      try {
        lookup = await request(url);
      } catch (error) {
        throw withoutPostcode(error);
      }
      if (!REDIRECTS.includes(lookup.response.status)) parseDxLookupPage(decodeText(lookup.bytes), number);
      const path = redirectPath(lookup.response);
      if (path === NOTICE) {
        throw new IndeterminateError(PROVIDER, 'DX found no consignment for that number and postcode', { reason: 'portal_not_found' });
      }
      if (path !== MENU) throw new SchemaError(PROVIDER, 'DX redirected the lookup to an unexpected page');
      const cookie = sessionCookie(lookup.response);
      const page = async (pagePath: string) => {
        const { response, bytes } = await request(`${ORIGIN}${pagePath}`, cookie);
        if (!REDIRECTS.includes(response.status)) return decodeText(bytes);
        // The tracker sends a session it no longer holds to its notice.
        if (redirectPath(response) === NOTICE) throw new IndeterminateError(PROVIDER, 'DX lost the lookup\'s session', { reason: 'session_rejected' });
        throw new SchemaError(PROVIDER, 'DX redirected a page of the lookup');
      };
      const menu = await page(MENU);
      return parseDxFreight(await page(HISTORY), menu, number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try in
    // a new session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dx', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Every freight lookup needs the postcode, and an unknown number and a wrong
  // postcode look alike, so the adapter cannot recognize a number alone.
  return {
    id: 'dx', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
