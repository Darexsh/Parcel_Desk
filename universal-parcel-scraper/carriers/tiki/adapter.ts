import { createHmac } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTikiNumber, parseTiki, PROVIDER, TIKI_MAX_BYTES } from './parser.js';

// The lookup TIKI's Android app makes for a resi typed in. The tracker on
// tiki.id posts its form with a reCAPTCHA token; the app signs a short-lived
// token with its own key, the same for every install, and needs no account.
export const TIKI_API = 'https://my.tiki.id/api/android/v4/connote/information';
export const TIKI_APP_KEY = 'xMhdbrzkML2Scqu4K5CiUf7xwxQNH6PzttZqJeniTiONlh6xPvEToT1GMj6Dlyb19qhbMDZSX08NyBNXIEGLan1QGhcDtFTE0jk1'; // gitleaks:allow
// The app's token is valid for 100 seconds from the moment it is made. The
// service refuses one issued in its future, so this one starts 50 seconds
// back: either clock may be off by that much.
const TOKEN_LIFETIME_S = 100;
const TOKEN_LEAD_S = 50;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha|_Incapsula_Resource|AwsWafIntegration/i;

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** The app's request token: an HS256 JWT for the subject `tiki`, signed with the app's key. */
export function tikiToken(nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - TOKEN_LEAD_S;
  const signed = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat, exp: iat + TOKEN_LIFETIME_S, sub: 'tiki' }))}`;
  return `${signed}.${base64url(createHmac('sha256', TIKI_APP_KEY).update(signed).digest())}`;
}

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TIKI answered with a block page', { status, cause });
    throw new SchemaError(PROVIDER, 'TIKI returned a reply that is not JSON', { cause });
  }
}

export class TikiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTikiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(TIKI_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Authorization: tikiToken(this.options.now?.()),
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ cnno: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: TIKI_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TIKI moved its tracking service');
      // An unknown resi is an empty list with HTTP 200; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'TIKI tracking service is unavailable');
      // The service repeats its envelope's status as the HTTP status: 403 for a
      // refused token, 400 for a resi it would not read.
      return parseTiki(json(decodeText(bytes), response.status), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tiki', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TikiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tiki', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTikiNumber(number))),
  };
};
