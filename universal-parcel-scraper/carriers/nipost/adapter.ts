import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { discoverActionId } from './action.js';
import { isChallengePage, NIPOST_MAX_BYTES, normalizeNipostNumber, parseNipost, PROVIDER, UnknownActionError } from './parser.js';

/** The tracking page, which opens one item at its code's path. */
export const NIPOST_PAGE = 'https://tracking.nipost.gov.ng/';
/**
 * The id of the page's tracking server action, tried first. Every visitor's
 * page carries the same one. When the tracker no longer knows it, the lookup
 * reads the current one from the page's chunks.
 */
export const NIPOST_ACTION = 'ff8e68acaa2d70e76e8ead171a57a6fe60335c8f';
// The page is a few tens of kilobytes, and its largest chunk, React's, under 200.
const PAGE_MAX_BYTES = 300_000;
const CHUNK_MAX_BYTES = 500_000;
/** How long an id read from the page stays the first try after it last answered. */
const ACTION_TTL_MS = 6 * 3_600_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The action answers an unknown code in its reply: a missing route is not a missing item.
const UNAVAILABLE = [405, 410];
const NOT_FOUND = 404;

export class NipostTracker {
  // An id the page named and the tracker then answered, for the lookups after it.
  private discovered: { id: string; until: number } | undefined;

  constructor(private readonly options: {
    fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string;
    /** The id tried first when none read from the page is current; the built-in one by default. */
    action?: string;
  } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNipostNumber(raw);
    const page = `${NIPOST_PAGE}${number}`;
    const cached = this.discovered && this.discovered.until > Date.now() ? this.discovered.id : undefined;
    let action = cached ?? this.options.action ?? NIPOST_ACTION;
    let stale = false;

    const refresh = async (signal: AbortSignal, deadline: number) => {
      const html = await this.get(page, signal, deadline, PAGE_MAX_BYTES);
      const found = await discoverActionId(html, page, url => this.get(url, signal, deadline, CHUNK_MAX_BYTES));
      if (found === undefined) throw new SchemaError(PROVIDER, 'NIPOST tracking page no longer names its lookup: the tracking lookup changed');
      // The page naming the id that just failed means the id is not what changed.
      if (found === action) throw new SchemaError(PROVIDER, 'NIPOST did not answer its own lookup: the tracking lookup changed');
      action = found;
      stale = false;
    };

    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      if (stale) await refresh(signal, deadline);
      const id = action;
      try {
        const result = await this.post(number, id, signal, deadline);
        this.remember(id);
        return result;
      } catch (error) {
        if (error instanceof NotFoundError) this.remember(id);
        if (error instanceof UnknownActionError) {
          stale = true;
          if (id === cached) this.discovered = undefined;
        }
        throw error;
      }
    };

    // The first try gets half of the budget, so a retry fits in the rest. An
    // action the tracker no longer has is read again from the page and tried
    // once more; a lookup that fails to reach NIPOST, or hangs, gets one retry.
    return runSteps({ carrier: 'nipost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      { id: 'action', recovers: error => error instanceof UnknownActionError,
        run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }

  private remember(id: string): void {
    if (id !== NIPOST_ACTION) this.discovered = { id, until: Date.now() + ACTION_TTL_MS };
  }

  private async post(number: string, action: string, signal: AbortSignal, deadline: number): Promise<CarrierResult> {
    // The page calls its action with the code from its path, as a one-item argument list.
    const { response, bytes } = await fetchBounded(`${NIPOST_PAGE}${number}`, { method: 'POST', signal, headers: {
      Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': action,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify([number]) }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes: NIPOST_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, NOT_FOUND, ...UNAVAILABLE] });
    // Next answers an action it does not have with 404 and this header, or, before version 15, with the page.
    if (response.status === NOT_FOUND || response.headers.has('x-nextjs-action-not-found')) throw new UnknownActionError();
    if (REDIRECTS.includes(response.status) || UNAVAILABLE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'NIPOST tracking lookup is unavailable', { status: response.status });
    }
    return parseNipost(bytes, response.headers.get('content-type'), number);
  }

  /** The page or one of its chunks, as text. */
  private async get(url: string, signal: AbortSignal, deadline: number, maxBytes: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: url.endsWith('.js') ? '*/*' : 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, NOT_FOUND, ...UNAVAILABLE] });
    if (REDIRECTS.includes(response.status) || response.status === NOT_FOUND || UNAVAILABLE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'NIPOST tracking page is unavailable', { status: response.status });
    }
    const text = decodeText(bytes);
    if (/^\s*</.test(text) && isChallengePage(text)) throw new ChallengeError(PROVIDER, 'NIPOST answered with a browser check');
    return text;
  }
}

const timeLeft = (deadline: number) => Math.max(1, Math.floor(deadline - performance.now()));

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NipostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'nipost', recordsSteps: true, steps: ['direct', 'action', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNipostNumber(number))),
  };
};
