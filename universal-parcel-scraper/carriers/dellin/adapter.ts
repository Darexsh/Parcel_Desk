import { createHash, randomUUID } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DELLIN_MAX_BYTES, normalizeDellinNumber, parseDellin, PROVIDER } from './parser.js';

/** The order search Dellin's customer app makes when a guest tracks a number. */
export const DELLIN_API = 'https://api.dellin.ru/v3/orders.json';
// The app key the customer app (ru.dellin.cabinet) ships for every install;
// the API refuses a request without a key it issued.
const APP_KEY = '3FEC448E-0ADC-11E6-A0A6-00505683A6D3'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Qrator's JavaScript check, which fronts Dellin's hosts.
const CHALLENGE = /__qrator|qauth\.js/i;

/**
 * A device id as the app mints one on its first start: a random UUID whose
 * first, tenth and twenty-fifth characters are replaced by the first three
 * hex digits of the MD5 of the rest. The API refuses an id without them.
 */
export function dellinDeviceId(uuid: string = randomUUID()): string {
  const parts = [uuid.slice(1, 9), uuid.slice(10, 24), uuid.slice(25, 36)];
  const check = createHash('md5').update(parts.join('')).digest('hex');
  return `${check[0]}${parts[0]}${check[1]}${parts[1]}${check[2]}${parts[2]}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 4_000))) throw new ChallengeError(PROVIDER, 'Delovye Linii answered with its bot check', { cause });
    throw new SchemaError(PROVIDER, 'Delovye Linii returned a reply that is not JSON', { cause });
  }
}

export class DellinTracker {
  // One device id per tracker, as one install of the app keeps its own.
  readonly #deviceId = dellinDeviceId();

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDellinNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(DELLIN_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ appKey: APP_KEY, deviceId: this.#deviceId, docIds: [number], orderDatesExtended: true }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DELLIN_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Delovye Linii redirected its order search');
      if (response.status === 401 || response.status === 403) {
        const body = decodeText(bytes).slice(0, 4_000);
        if (CHALLENGE.test(body)) throw new ChallengeError(PROVIDER, 'Delovye Linii answered with its bot check', { status: response.status });
        throw new ChallengeError(PROVIDER, 'Delovye Linii refused the app\'s key', { status: response.status });
      }
      // A 400 carries the API's own errors, among them its answer to an unknown number.
      return parseDellin(json(decodeText(bytes)), number);
    };
    // A request that fails to reach Dellin, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dellin', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DellinTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dellin', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
