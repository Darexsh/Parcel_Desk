import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { fastTrackerConsignment, fastTrackerItemUrl, fastTrackerResult, fastTrackerSearchUrl, MAX_ITEM_PAGES, parseFastTrackerItem,
  parseFastTrackerSearch, TGE_NZ_MAX_BYTES, type FastTrackerItemPage } from './fastTracker.js';
import { normalizeTeamGlobalExpressNumber, parseTeamGlobalExpressDetails, parseTeamGlobalExpressSearch, PROVIDER, teamGlobalExpressDetailsUrl,
  teamGlobalExpressSearchUrl, TGE_DETAILS_MAX_BYTES, TGE_SEARCH_MAX_BYTES } from './parser.js';

export { TGE_DETAILS, TGE_SEARCH } from './parser.js';
export { TGE_NZ_TRACKER } from './fastTracker.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class TeamGlobalExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTeamGlobalExpressNumber(raw);
    // One attempt asks MyTeamGE's quick search for the number, as its track
    // box does, and opens the shipment page of the row that names it. A number
    // of New Zealand's layout is asked first of New Zealand's Fast Tracker,
    // which opens a page per item. None needs a cookie, a token or a browser.
    const consignment = fastTrackerConsignment(number);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const read = async (url: string, maxBytes: number): Promise<string> => {
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
          headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER, timeoutMs: left(), maxBytes,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 405] });
        // All answer every number with HTTP 200; a redirect or a 404 is a moved route or an error page.
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Team Global Express redirected its tracking lookup');
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Team Global Express tracking lookup is unavailable');
        // AWS's firewall asks for a CAPTCHA with HTTP 405 after a burst of
        // lookups; MyTeamGE's page then says the address made too many requests.
        if (response.status === 405) {
          throw new RateLimitedError(PROVIDER, undefined, 'Team Global Express asked for a CAPTCHA after too many lookups', { status: 405 });
        }
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'Team Global Express refused the lookup', { status: 403 });
        if (response.headers.get('x-amzn-waf-action')) throw new ChallengeError(PROVIDER, 'Team Global Express answered with a browser check');
        return decodeText(bytes);
      };
      if (consignment) {
        try {
          const items = parseFastTrackerSearch(await read(fastTrackerSearchUrl(consignment), TGE_NZ_MAX_BYTES), consignment);
          const pages: FastTrackerItemPage[] = [];
          for (const item of items.slice(0, MAX_ITEM_PAGES)) pages.push(parseFastTrackerItem(await read(fastTrackerItemUrl(item.id), TGE_NZ_MAX_BYTES), item));
          return fastTrackerResult(number, consignment, items, pages);
        } catch (error) {
          // A consignment Fast Tracker does not hold may still be MyTeamGE's.
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      const match = parseTeamGlobalExpressSearch(await read(teamGlobalExpressSearchUrl(number), TGE_SEARCH_MAX_BYTES), number);
      return parseTeamGlobalExpressDetails(await read(teamGlobalExpressDetailsUrl(match.id), TGE_DETAILS_MAX_BYTES), number, match);
    };
    // An attempt that fails to reach MyTeamGE, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'team-global-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TeamGlobalExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'team-global-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTeamGlobalExpressNumber(number))),
  };
};
