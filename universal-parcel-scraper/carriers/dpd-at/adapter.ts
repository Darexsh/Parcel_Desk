import { accepted, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPD_AT_MAX_BYTES, dpdAtNumber, PROVIDER, readDpdAt, type DpdAtReading } from './parser.js';

/** The lookup myDPD's page makes for the number typed in. */
export const DPD_AT_SEARCH = 'https://www.mydpd.at/jws.php/parcel/search';
const REDIRECTS = [301, 302, 303, 307, 308];
// Radware's bot manager answers with its own page in place of the reply, or
// sends the browser to its captcha on perfdrive.com.
const CHALLENGE = /<title>\s*Radware (?:Captcha )?Page\s*<\/title>|Verifying your browser|perfdrive\.com|shieldsquare/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'myDPD answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'myDPD returned a reply that is not JSON', { cause });
  }
}

export class DpdAtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async read(raw: string, context: TrackingContext = {}): Promise<DpdAtReading> {
    const number = dpdAtNumber(raw);
    const search = async (signal: AbortSignal, timeoutMs: number): Promise<DpdAtReading> => {
      const { response, bytes } = await fetchBounded(DPD_AT_SEARCH, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: DPD_AT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
      if (REDIRECTS.includes(response.status)) {
        if (CHALLENGE.test(response.headers.get('location') ?? '')) throw new ChallengeError(PROVIDER, 'myDPD sent the lookup to a captcha');
        throw new TransportError(PROVIDER, 'myDPD redirected its tracking lookup');
      }
      return readDpdAt(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'dpd-at', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => search(signal, remainingMs) },
    ]);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return (await this.read(raw, context)).result;
  }

  /**
   * Whether myDPD knows the parcel and its newest scan is in Austria. DPD
   * Austria is the preferred carrier for its depots' numbers, so a parcel that
   * has since moved to another country is left to that country's network,
   * and a newest scan without a country is inconclusive.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => dpdAtNumber(raw))) return { known: false };
    let reading: DpdAtReading;
    try {
      reading = await this.read(raw, context);
    } catch (error) {
      if (error instanceof NotFoundError) return { known: false };
      throw error;
    }
    if (!reading.country) throw new IndeterminateError(PROVIDER, 'myDPD named no country for the newest scan');
    if (reading.country !== 'AT') return { known: false };
    return recognizeFromLookup(() => Promise.resolve(reading.result));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdAtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dpd-at', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
