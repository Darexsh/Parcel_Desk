import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { IDS_MAX_BYTES, IDS_PARTNERS_MAX_BYTES, normalizeIdsNumber, normalizeIdsPostcode, parseIdsPartners, parseIdsReply, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.ids-logistik.de';
/** The lookup IDS's tracking page makes with the number and postcode in its address. */
export const IDS_STATUS_API = `${ORIGIN}/api/shipping/status`;
/** The partner list the page reads to name each depot's town. */
export const IDS_PARTNERS_API = `${ORIGIN}/api/ids/partner`;
/** The flag the page reads to show its maintenance notice instead of a shipment. */
export const IDS_MAINTENANCE_API = `${ORIGIN}/api/maintenance/state`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown shipment with an empty record: a missing route is not a missing shipment.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;
// Partners join and leave rarely; the page reads the list on every lookup.
const PARTNERS_TTL_MS = 6 * 60 * 60_000;
// The side reads give up rather than hold the answer.
const SIDE_READ_MS = 5_000;
const MAINTENANCE_MAX_BYTES = 16 * 1024;

function json(bytes: Uint8Array): unknown {
  const head = decodeText(bytes.subarray(0, 64_000));
  try {
    return parseJsonBytes(bytes, PROVIDER);
  } catch (cause) {
    if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'IDS Logistik answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'IDS Logistik returned a reply that is not JSON', { cause });
  }
}

export class IdsLogistikTracker {
  #towns: { at: number; towns: ReadonlyMap<string, string> } | null = null;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  #headers(): Record<string, string> {
    return { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent) };
  }

  async #get(url: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<unknown> {
    const { bytes } = await fetchBounded(url, { method: 'GET', signal, headers: this.#headers() },
      { provider: PROVIDER, timeoutMs, maxBytes, fetcher: this.options.fetcher });
    return json(bytes);
  }

  /**
   * Each depot's town, from a list read in the last hours or read now. Null
   * when the list cannot be read, which leaves the scans without their town.
   */
  async #depotTowns(signal: AbortSignal, timeoutMs: number): Promise<ReadonlyMap<string, string> | null> {
    if (this.#towns && Date.now() - this.#towns.at < PARTNERS_TTL_MS) return this.#towns.towns;
    try {
      const towns = parseIdsPartners(await this.#get(IDS_PARTNERS_API, signal, timeoutMs, IDS_PARTNERS_MAX_BYTES));
      this.#towns = { at: Date.now(), towns };
      return towns;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  /**
   * A not-found answer, unless the page's maintenance flag is up: the lookup
   * keeps answering while the flag hides it. A flag that cannot be read
   * leaves the answer as it is.
   */
  async #notFoundUnlessMaintenance(error: CarrierError, signal: AbortSignal, timeoutMs: number): Promise<never> {
    let state: unknown = null;
    try {
      state = await this.#get(IDS_MAINTENANCE_API, signal, timeoutMs, MAINTENANCE_MAX_BYTES);
    } catch {
      signal.throwIfAborted();
    }
    if (isRecord(state) && state.active === true) throw new MaintenanceError(PROVIDER, 'IDS Logistik tracking is under maintenance', { cause: error });
    throw error;
  }

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIdsNumber(raw);
    const postcode = normalizeIdsPostcode(rawPostcode);
    const body = JSON.stringify({ trackingNumber: number, zipCode: postcode });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const { response, bytes } = await fetchBounded(IDS_STATUS_API, { method: 'POST', body, signal, headers: {
        ...this.#headers(), 'Content-Type': 'application/json',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: IDS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'IDS Logistik tracking lookup is unavailable', { status: response.status });
      }
      const payload = json(bytes);
      const left = () => Math.max(1, Math.min(SIDE_READ_MS, Math.floor(deadline - Date.now())));
      let result: CarrierResult;
      try {
        result = parseIdsReply(payload, number, postcode);
      } catch (error) {
        if (error instanceof CarrierError && error.kind === 'not_found') return this.#notFoundUnlessMaintenance(error, signal, left());
        throw error;
      }
      // Only scans have a depot to name.
      if (!result.events?.length) return result;
      return parseIdsReply(payload, number, postcode, await this.#depotTowns(signal, left()));
    };
    // A lookup that fails to reach IDS, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ids-logistik', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IdsLogistikTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // The postcode is part of every lookup, so the adapter cannot recognize a number alone.
  return {
    id: 'ids-logistik', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
