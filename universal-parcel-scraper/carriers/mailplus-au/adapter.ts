import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isSyncable, MAILPLUS_MAX_BYTES, normalizeMailplusNumber, parseMailplus, PROVIDER } from './parser.js';

/** The lookup the tracker at track.mailplus.com.au makes, on MailPlus's customer API. */
export const MAILPLUS_API = 'https://wapp.mailplus.com.au/api/v1/customer/trackings/public/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;
// Time the refresh leaves for the step to hand back the answer it already has.
const REFRESH_MARGIN_MS = 250;

/** The lookup's address for a number, as the page builds it; `syncable` asks for the partner's newest scans. */
export function mailplusTrackUrl(number: string, syncable = false): string {
  return `${MAILPLUS_API}${encodeURIComponent(number)}${syncable ? '?syncable=true' : ''}`;
}

/** Seconds in a Retry-After header, in milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
  return header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'MailPlus answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'MailPlus returned a reply that is not JSON', { cause });
  }
}

/** The first message of the API's `{"errors": [...]}` reply, if the reply is one. */
function errorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.errors) || 'events' in payload) return undefined;
  return typeof payload.errors[0] === 'string' ? payload.errors[0] : '';
}

export class MailplusTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One parcel; `refresh: false` skips the page's second, slower read of a parcel it can refresh. */
  async fetch(raw: string, context: TrackingContext = {}, { refresh = true } = {}): Promise<CarrierResult> {
    const number = normalizeMailplusNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number, syncable: boolean): Promise<{ result: CarrierResult; syncable: boolean }> => {
      const { response, bytes } = await fetchBounded(mailplusTrackUrl(number, syncable), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAILPLUS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 409, 410, 429] });
      const body = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'MailPlus redirected its tracking lookup');
      if (response.status === 429) {
        throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')), 'MailPlus refused more lookups for now', { status: 429 });
      }
      if (response.status === 403) {
        const message = CHALLENGE.test(body.slice(0, 64_000)) ? 'MailPlus answered with a browser check' : 'MailPlus refused the lookup';
        throw new ChallengeError(PROVIDER, message, { status: 403 });
      }
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'MailPlus tracking lookup is unavailable', { status: response.status });
      const payload = json(body);
      const message = errorMessage(payload);
      // The API checks the layout first: "This barcode is not valid." (HTTP 400), then
      // "There are no results for this tracking." (HTTP 409) for a number it does not hold.
      if (message !== undefined) {
        if (/\bnot valid\b/i.test(message)) throw new InvalidInputError(PROVIDER, 'MailPlus does not take this number', { reason: 'wrong_number' });
        if (/\bno results\b/i.test(message)) throw new NotFoundError(PROVIDER);
        throw new SchemaError(PROVIDER, 'MailPlus returned an unexpected error', { status: response.status });
      }
      if (response.status !== 200) throw new SchemaError(PROVIDER, 'MailPlus returned an unexpected reply', { status: response.status });
      return { result: parseMailplus(payload, number), syncable: isSyncable(payload) };
    };
    // The page asks a parcel the tracker can refresh once more with `syncable=true`, which
    // brings in the partner's newest scans. The first answer stands when that read fails.
    const lookup = async (signal: AbortSignal, firstMs: number, windowMs: number): Promise<CarrierResult> => {
      const started = Date.now();
      const first = await read(signal, firstMs, false);
      const left = windowMs - (Date.now() - started) - REFRESH_MARGIN_MS;
      if (!refresh || !first.syncable || left < 1) return first.result;
      try {
        return (await read(signal, left, true)).result;
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return first.result;
      }
    };
    // A request that fails to reach the service, or hangs, gets one more try: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'mailplus-au', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => lookup(signal, firstAttemptMs(remainingMs), remainingMs) },
      networkRetryStep(({ signal, remainingMs }) => lookup(signal, remainingMs, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MailplusTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mailplus-au', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, { refresh: false }),
      () => accepted(() => normalizeMailplusNumber(number))),
  };
};
