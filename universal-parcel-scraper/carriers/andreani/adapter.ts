import { createCipheriv } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ANDREANI_MAX_BYTES, normalizeAndreaniNumber, parseAndreani, PROVIDER } from './parser.js';

/** The lookup the tracking page on andreani.com makes for one number. */
export const ANDREANI_API = 'https://tracking-api.andreani.com/api/v3/Tracking';
// The key, IV and token the tracking page's script gives every visitor, the same for all.
const PAYLOAD_KEY = '12345678901234567890123456789012'; // gitleaks:allow
const PAYLOAD_IV = '1234567890123456'; // gitleaks:allow
const PAGE_TOKEN = 'XqPMiwXzTRKHH0mF3gmtPtQt3LNGIuqCTdgaUHINMdmlaFid0x9MzlYTKXPxluYQ'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the service answers an unknown number with HTTP 206.
const GONE = [404, 410];
// Andreani's web firewall answers a request it blocks with HTTP 500 and a block page.
const FAILED = 500;
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|The URL you requested has been blocked)|Web Page Blocked!/i;

/**
 * The query the page sends: the receiver and system it names itself with and
 * the number, as JSON, under AES-256-CBC with the page's key and IV, in Base64.
 */
export function andreaniPayload(number: string): string {
  const query = JSON.stringify({ idReceptor: 1, idSistema: 1, userData: JSON.stringify({ mail: '' }), numeroAndreani: number });
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(PAYLOAD_KEY, 'utf8'), Buffer.from(PAYLOAD_IV, 'utf8'));
  return Buffer.concat([cipher.update(query, 'utf8'), cipher.final()]).toString('base64');
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Andreani answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Andreani returned a reply that is not JSON', { cause });
  }
}

export class AndreaniTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAndreaniNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = `${ANDREANI_API}?${new URLSearchParams({ payload: andreaniPayload(number) })}`;
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', Authorization: PAGE_TOKEN, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ANDREANI_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, FAILED] });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Andreani moved its tracking service');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Andreani tracking service is unavailable');
      const body = decodeText(bytes);
      if (response.status === FAILED) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Andreani’s firewall refused the lookup', { status: FAILED });
        throw new IndeterminateError(PROVIDER, 'Andreani tracking service failed', { status: FAILED });
      }
      return parseAndreani(json(body), number);
    };
    // A request that fails to reach Andreani, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'andreani', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AndreaniTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'andreani', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAndreaniNumber(number))),
  };
};
