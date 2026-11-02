import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeSkyboxNumber, parseSkybox, PROVIDER, SKYBOX_MAX_BYTES } from './parser.js';

/** The fragment SkyBox's public tracking page loads for a number. */
export const SKYBOX_TRACKING = 'https://www.skybox.net/TrackingInformation/GetContentPublic';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The fragment's address for one number. */
export function skyboxTrackingUrl(number: string): string {
  return `${SKYBOX_TRACKING}?${new URLSearchParams({ tracking: number })}`;
}

export class SkyboxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(skyboxTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SKYBOX_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The fragment answers HTTP 200 for a number it does not know; a redirect, such as to the site's error page, or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'SkyBox tracking fragment moved', { status: response.status });
    return parseSkybox(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkyboxNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkyboxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSkyboxNumber(number))),
  };
};
