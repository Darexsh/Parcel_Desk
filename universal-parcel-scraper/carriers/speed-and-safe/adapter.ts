import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeedAndSafeNumber, parseSpeedAndSafe, PROVIDER, SPEED_AND_SAFE_MAX_BYTES } from './parser.js';

/** The ERP's status lookup, which the tracking page's script makes for the number typed in. */
export const SPEED_AND_SAFE_API = 'https://erp.gokulamspeedandsafe.com/online/getconsignmentstatus';
const REDIRECTS = [301, 302, 303, 307, 308];
// Sucuri's firewall in front of the ERP, and other bot checks, could answer in place of the reply.
const CHALLENGE = /sucuri|cloudproxy|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one whole number. */
export function speedAndSafeLookupUrl(number: string): string {
  return `${SPEED_AND_SAFE_API}?consignmentno=${encodeURIComponent(normalizeSpeedAndSafeNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Gokulam Speed & Safe answered with a firewall page', { cause });
    throw new SchemaError(PROVIDER, 'Gokulam Speed & Safe returned a reply that is not JSON', { cause });
  }
}

export class SpeedAndSafeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(speedAndSafeLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SPEED_AND_SAFE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // The lookup reads a missing consignment from a 200 reply; a redirect or a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Gokulam Speed & Safe tracking lookup is unavailable', { status: response.status });
    }
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Gokulam Speed & Safe refused the lookup', { status: 403 });
    return parseSpeedAndSafe(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpeedAndSafeNumber(raw);
    // A read that fails to reach the lookup, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'speed-and-safe', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpeedAndSafeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'speed-and-safe', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
