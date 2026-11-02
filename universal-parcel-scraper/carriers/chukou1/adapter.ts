import { createCipheriv, createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { CHUKOU1_MAX_BYTES, normalizeChukou1Number, parseChukou1, PROVIDER } from './parser.js';

/** The lookup the tracking page on ec.chukou1.com, Chukou1's EC-FirstClass platform, makes for the numbers typed in. */
export const CHUKOU1_API = 'https://ec-gateway.chukou1.com/api/v1/trackings?lang=en-US';
// The text the page's script signs every visitor's lookup with: the salt of
// the key's hash and the IV of the number's encryption.
const PAGE_SECRET = 'Vnj25FYu3mIjbNUS'; // gitleaks:allow
// The code of the gateway's refusal of a lookup signed with a clock it does not accept.
const ILLEGAL_QUERY = '200F1004';
// The gateway takes a signature within about 45 seconds of its own clock. A
// refused lookup whose clock was further off than this is signed again with the gateway's.
const CLOCK_SKEW_MS = 10_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

/**
 * The body the page posts for a number at an instant: `securityKey` is the
 * MD5 of the UTC clock (yyyyMMddHHmmss and hundredths) with the page's text,
 * and the clock's last four digits; `securityValue` is the number, encrypted
 * with AES-256-CBC under that hash, in hex.
 */
export function signChukou1Lookup(number: string, instant: number): { securityKey: string; securityValue: string } {
  const stamp = DateTime.fromMillis(instant, { zone: 'UTC' }).toFormat('yyyyMMddHHmmssSSS').slice(0, 16);
  const key = createHash('md5').update(stamp + PAGE_SECRET).digest('hex');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(PAGE_SECRET, 'utf8'));
  return { securityKey: key + stamp.slice(-4), securityValue: Buffer.concat([cipher.update(number, 'utf8'), cipher.final()]).toString('hex') };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Chukou1 returned a reply that is not JSON', { cause });
  }
}

/** The gateway's clock, when its HTTP 400 refuses the lookup's signature; null for any other refusal. */
function refusedClock(payload: unknown): number | null {
  if (!isRecord(payload) || !Array.isArray(payload.Errors) || typeof payload.UtcDateTime !== 'string') return null;
  if (!payload.Errors.some((error) => isRecord(error) && error.Code === ILLEGAL_QUERY)) return null;
  const clock = DateTime.fromISO(payload.UtcDateTime, { setZone: true });
  return clock.isValid && /(?:Z|[+-]\d{2}:\d{2})$/.test(payload.UtcDateTime) ? clock.toMillis() : null;
}

export class Chukou1Tracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChukou1Number(raw);
    const now = this.options.now ?? Date.now;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      let offset = 0;
      for (let signed = 1; ; signed += 1) {
        const { response, bytes } = await fetchBounded(CHUKOU1_API, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
        }, body: JSON.stringify(signChukou1Lookup(number, now() + offset)) }, { provider: PROVIDER,
          timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: CHUKOU1_MAX_BYTES, redirect: 'manual',
          fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
        const body = decodeText(bytes);
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Chukou1 redirected its tracking lookup', { status: response.status });
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Chukou1 answered with a browser check', { status: response.status });
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'Chukou1 refused the lookup', { status: 403 });
        // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
        if (response.status === 404 || response.status === 410) {
          throw new TransportError(PROVIDER, 'Chukou1 tracking lookup is unavailable', { status: response.status });
        }
        if (response.status === 400) {
          const clock = refusedClock(json(body));
          // A clock too far from the gateway's is corrected once; a signature
          // refused at the gateway's own clock means the page signs differently now.
          if (clock !== null && signed === 1 && Math.abs(clock - now() - offset) > CLOCK_SKEW_MS) {
            offset = clock - now();
            continue;
          }
          throw new SchemaError(PROVIDER, 'Chukou1 refused the signed lookup', { status: 400 });
        }
        return parseChukou1(json(body), number);
      }
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'chukou1', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Chukou1Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'chukou1', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChukou1Number(number))),
  };
};
