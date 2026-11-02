import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { discoverActionId } from './action.js';
import { isChallengePage, normalizeTracxNumber, parseTracx, PROVIDER, readActionReply, TRACX_MAX_BYTES, UnknownActionError } from './parser.js';

/** The tracking page, whose server actions look a parcel up. */
export const TRACX_PAGE = 'https://www.tracxlogis.com/tracking';
/**
 * The id of the page's `getTrackingHistory` action, tried first. Every
 * visitor's page carries the same one until the site is built again; when the
 * tracker no longer knows it, the lookup reads the current one from the page.
 */
export const TRACX_ACTION = '406dae20d6d6ebbae5417f417519605f84915781b6';
// The page is about a hundred kilobytes, and each of its chunks under a hundred.
const PAGE_MAX_BYTES = 600_000;
const CHUNK_MAX_BYTES = 600_000;
/** How long an id read from the page stays the first try after it last answered. */
const ACTION_TTL_MS = 6 * 3_600_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [405, 410];
const NOT_FOUND = 404;

export class TracxTracker {
  // An id the page named and the tracker then answered, for the lookups after it.
  private discovered: { id: string; until: number } | undefined;

  constructor(private readonly options: {
    fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string;
    /** The id tried first when none read from the page is current; the built-in one by default. */
    action?: string;
  } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTracxNumber(raw);
    const cached = this.discovered && this.discovered.until > Date.now() ? this.discovered.id : undefined;
    let action = cached ?? this.options.action ?? TRACX_ACTION;
    let stale = false;

    const refresh = async (signal: AbortSignal, deadline: number) => {
      const html = await this.get(TRACX_PAGE, signal, deadline, PAGE_MAX_BYTES);
      const found = await discoverActionId(html, TRACX_PAGE, url => this.get(url, signal, deadline, CHUNK_MAX_BYTES));
      if (found === undefined) throw new SchemaError(PROVIDER, 'TracX Logis tracking page no longer names its lookup: the tracking lookup changed');
      // The page naming the id that just failed means the id is not what changed.
      if (found === action) throw new SchemaError(PROVIDER, 'TracX Logis did not answer its own lookup: the tracking lookup changed');
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
    // once more; a lookup that fails to reach TracX Logis, or hangs, gets one retry.
    return runSteps({ carrier: 'tracx-logis', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      { id: 'action', recovers: error => error instanceof UnknownActionError,
        run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }

  private remember(id: string): void {
    if (id !== TRACX_ACTION) this.discovered = { id, until: Date.now() + ACTION_TTL_MS };
  }

  private async post(number: string, action: string, signal: AbortSignal, deadline: number): Promise<CarrierResult> {
    // The page calls its action with the number typed in, as a one-item argument list.
    const { response, bytes } = await fetchBounded(TRACX_PAGE, { method: 'POST', signal, headers: {
      Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': action,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify([number]) }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes: TRACX_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, NOT_FOUND, ...UNAVAILABLE] });
    // Next answers an action it does not have with 404 and this header.
    if (response.headers.has('x-nextjs-action-not-found')) throw new UnknownActionError();
    if (response.status === 403) {
      if (isChallengePage(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'TracX Logis answered with a browser check');
      throw new ChallengeError(PROVIDER, 'TracX Logis refused the lookup', { status: 403 });
    }
    if (REDIRECTS.includes(response.status) || response.status === NOT_FOUND || UNAVAILABLE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'TracX Logis tracking lookup is unavailable', { status: response.status });
    }
    return parseTracx(readActionReply(bytes, response.headers.get('content-type')), number);
  }

  /** The page or one of its chunks, as text. */
  private async get(url: string, signal: AbortSignal, deadline: number, maxBytes: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: url.endsWith('.js') ? '*/*' : 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: timeLeft(deadline), maxBytes, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, NOT_FOUND, ...UNAVAILABLE] });
    const text = decodeText(bytes);
    if (response.status === 403 || (/^\s*</.test(text) && isChallengePage(text))) {
      throw new ChallengeError(PROVIDER, 'TracX Logis answered its tracking page with a browser check');
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'TracX Logis tracking page is unavailable', { status: response.status });
    return text;
  }
}

const timeLeft = (deadline: number) => Math.max(1, Math.floor(deadline - performance.now()));

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TracxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tracx-logis', recordsSteps: true, steps: ['direct', 'action', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTracxNumber(number))),
  };
};
