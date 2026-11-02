import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeTransmissionNumber, normalizeTransmissionPostcode, parseSearchReply, parseTransmissionPage, PROVIDER, TRANSMISSION_MAX_BYTES,
} from './parser.js';

const ORIGIN = 'https://api.trans-mission.nl';
/** The tracker's search form, which takes the number and the recipient's postcode. */
export const TRANSMISSION_SEARCH = `${ORIGIN}/Search-shipment`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The shipment's page: `/tt/{number}/{postcode}`.
const PAGE = /^\/tt\/([^/?#]+)\/([^/?#]+)\/?$/;

/**
 * The shipment page the search form sends the browser to, bound to the
 * shipment and postcode asked. Null for any other address.
 */
function pageOf(location: string | null, shipment: string, postcode: string): string | null {
  let url: URL;
  try {
    url = new URL(location ?? '', TRANSMISSION_SEARCH);
  } catch {
    return null;
  }
  const match = url.origin === ORIGIN ? PAGE.exec(url.pathname) : null;
  if (!match) return null;
  let number: string, code: string;
  try {
    [number, code] = [match[1]!, match[2]!].map((part) => decodeURIComponent(part).toUpperCase()) as [string, string];
  } catch {
    return null;
  }
  if (number !== shipment) throw new SchemaError(PROVIDER, 'TransMission answered for another shipment');
  if (code.replace(/\s+/g, '') !== postcode) throw new SchemaError(PROVIDER, 'TransMission answered for another postcode');
  return url.href;
}

export class TransmissionTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const { asked, shipment } = normalizeTransmissionNumber(raw);
    const postcode = normalizeTransmissionPostcode(rawPostcode);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      // The form posts the number and postcode, and sends a shipment it finds on to its page.
      const search = await fetchBounded(TRANSMISSION_SEARCH, { method: 'POST', signal, headers: {
        ...headers, 'Content-Type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ shipment_id: asked, zipcode: postcode }).toString() }, { provider: PROVIDER, timeoutMs: left(),
        maxBytes: TRANSMISSION_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
      if (!REDIRECTS.includes(search.response.status)) return parseSearchReply(decodeText(search.bytes), asked, postcode);
      const page = pageOf(search.response.headers.get('location'), shipment, postcode);
      if (!page) throw new IndeterminateError(PROVIDER, 'TransMission sent the search elsewhere');
      const { response, bytes } = await fetchBounded(page, { method: 'GET', signal, headers }, { provider: PROVIDER, timeoutMs: left(),
        maxBytes: TRANSMISSION_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
      // The page sends a shipment it cannot show back to the search form, by redirect or a Refresh header.
      if (REDIRECTS.includes(response.status) || response.headers.has('refresh')) {
        throw new IndeterminateError(PROVIDER, 'TransMission did not show the shipment it found');
      }
      return parseTransmissionPage(decodeText(bytes), asked);
    };
    // A lookup that fails to reach TransMission, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'transmission', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TransmissionTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // The postcode is part of every lookup, so the adapter cannot recognize a number alone.
  return {
    id: 'transmission', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
