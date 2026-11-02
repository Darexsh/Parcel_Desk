import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  J_AND_T_MIDDLE_EAST_MAX_BYTES, J_AND_T_MIDDLE_EAST_REQUEST_ZONE, normalizeJAndTMiddleEastNumber, parseJAndTMiddleEast, PROVIDER,
} from './parser.js';

/** The lookup the tracking page on www.jtexpress.me makes for a waybill. */
export const J_AND_T_MIDDLE_EAST_API = 'https://ofmg.jtjms-sa.com/official/logisticsTracking/v2/getDetailByWaybillNo';
/** The switch the page's captcha script reads before it asks a visitor to solve J&T's captcha. */
export const J_AND_T_MIDDLE_EAST_CAPTCHA_SWITCH = 'https://cms.jtexpress.com/overseas/captcha/captcha-switch.json';
/** The ticket and random string the captcha script hands the lookup while the switch is off. */
export const SWITCHED_OFF_TICKET = 'captcha-close';
// The page's own limit for reading the switch.
const SWITCH_TIMEOUT_MS = 8_000;
// A reading of the switch serves the lookups of the next few minutes, as one page load does.
const SWITCH_TTL_MS = 5 * 60_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply; the API sits behind CloudFront and Aliyun.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    // A JSON lookup answering with a page has been turned away.
    if (CHALLENGE.test(body.slice(0, 64_000)) || /^\s*</.test(body)) {
      throw new ChallengeError(PROVIDER, 'J&T Express Middle East answered with a page instead of its lookup', { cause });
    }
    throw new SchemaError(PROVIDER, 'J&T Express Middle East returned a reply that is not JSON', { cause });
  }
}

export class JAndTMiddleEastTracker {
  private captcha?: { required: boolean; until: number };

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /**
   * Whether J&T's captcha is on, read as the page's script reads it: only a
   * JSON switch whose `enabled` is `false` turns it off, and a switch the
   * script cannot read counts as off.
   */
  private async captchaRequired(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.captcha && this.captcha.until > Date.now()) return this.captcha.required;
    let required: boolean;
    try {
      const { bytes } = await fetchBounded(`${J_AND_T_MIDDLE_EAST_CAPTCHA_SWITCH}?t=${Date.now()}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(Math.min(SWITCH_TIMEOUT_MS, timeoutMs))), maxBytes: 4096,
        redirect: 'manual', fetcher: this.options.fetcher });
      const value: unknown = JSON.parse(decodeText(bytes));
      required = !value || !isRecord(value) || value.enabled !== false;
    } catch {
      // Only the caller's own cancellation ends the lookup here.
      signal.throwIfAborted();
      return false;
    }
    this.captcha = { required, until: Date.now() + SWITCH_TTL_MS };
    return required;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJAndTMiddleEastNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const started = Date.now();
      // The page asks a visitor to solve the captcha while the switch is on; the adapter does not.
      if (await this.captchaRequired(signal, timeoutMs / 3)) {
        throw new ChallengeError(PROVIDER, 'J&T Express Middle East asks for a captcha before each lookup');
      }
      const { response, bytes } = await fetchBounded(J_AND_T_MIDDLE_EAST_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
        // The page's headers: its language, the zone the scan times come in, and its country (1 is Saudi Arabia).
        langType: 'EN', timezone: J_AND_T_MIDDLE_EAST_REQUEST_ZONE, countryId: '1',
      }, body: JSON.stringify({ waybillNo: [number], langType: 'EN', ticket: SWITCHED_OFF_TICKET, randstr: SWITCHED_OFF_TICKET }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs - (Date.now() - started))), maxBytes: J_AND_T_MIDDLE_EAST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'J&T Express Middle East redirected its tracking lookup');
      // The lookup answers every waybill with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'J&T Express Middle East tracking lookup is unavailable');
      return parseJAndTMiddleEast(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'j-and-t-middle-east', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JAndTMiddleEastTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'j-and-t-middle-east', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
