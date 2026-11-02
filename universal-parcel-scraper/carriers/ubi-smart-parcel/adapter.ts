import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeUbiNumber, PROVIDER, readUbiReply, UBI_MAX_BYTES, type UbiReply } from './parser.js';

export const UBI_ORIGIN = 'https://shipper.ubismartparcel.com';
// The service the tracking page at shipper.ubismartparcel.com/#/ubi asks,
// without an account, key, cookie or CAPTCHA token.
export const UBI_ENDPOINT = `${UBI_ORIGIN}/api/aggregator/v1/track/trackParcel`;
// A missing route is not a missing parcel: an unknown number is the service's own `missTrackingNos`.
const GONE = [404, 410];
// A CDN's or firewall's block page instead of the service's JSON.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-turnstile|_cf_chl_opt|captcha|The requested URL was rejected/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The request the tracking page sends for one number, with the portal's host as its server name. */
export function ubiRequestBody(raw: string): string {
  return JSON.stringify({ trackingNo: normalizeUbiNumber(raw), serverName: new URL(UBI_ORIGIN).host });
}

export class UbiSmartParcelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async lookup(raw: string, context: TrackingContext = {}): Promise<UbiReply> {
    const body = ubiRequestBody(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<UbiReply> => {
      const { response, bytes } = await fetchBounded(UBI_ENDPOINT, { method: 'POST', signal, body, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8',
        // The page sends its language; the scans' wording is the same in every one.
        language: 'en_US', Origin: UBI_ORIGIN, Referer: `${UBI_ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: UBI_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [...GONE, 429] });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'UBI Smart Parcel tracking service is unavailable');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'UBI Smart Parcel answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'UBI Smart Parcel returned a reply that is not JSON', { cause });
      }
      return readUbiReply(payload, raw, Date.now());
    };
    // A request that fails to reach UBI, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ubi-smart-parcel', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return (await this.lookup(raw, context)).result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UbiSmartParcelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ubi-smart-parcel', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The tracker also finds a parcel by its partner's number, which is the
    // partner's to claim: that hit proves nothing about UBI.
    recognize: (number, context) => recognizeFromLookup(async () => {
      const reply = await tracker.lookup(number, context);
      if (reply.partnerNumber) throw new IndeterminateError(PROVIDER, 'UBI Smart Parcel found the parcel by its partner’s number');
      return reply.result;
    }, () => accepted(() => normalizeUbiNumber(number))),
  };
};
