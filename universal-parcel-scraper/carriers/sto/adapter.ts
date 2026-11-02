import { createHash } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeStoNumber, parseSto, STO_PROVIDER } from './parser.js';

// The trace behind STO's online customer-service page,
// https://page.sto.cn/ued-projects/sto-customer-onlinekf (linked from www.sto.cn).
// Its request hook signs every call with a source label, the time in
// milliseconds and an MD5 of both plus a fixed salt.
const ENDPOINT = 'https://customerservice-onlinemessageapi.sto.cn/interactive/getExternalTrace/';
// Shared request-signing label and salt of STO's public online customer-service page, distributed with the maintainer's approval.
export const STO_SOURCE = 'sto-staff';
export const STO_SALT = 'sto-staff-sk-000';

export function stoSignature(timestamp: string, salt: string): string {
  return createHash('md5').update(STO_SOURCE + timestamp + salt).digest('hex');
}

export class StoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeStoNumber(raw);
    return runSteps({ carrier: 'sto', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const timestamp = String(Date.now());
      try {
        const { bytes } = await fetchBounded(ENDPOINT + number, { signal, headers: {
          Accept: 'application/json', source: STO_SOURCE, timestamp, safeToken: stoSignature(timestamp, STO_SALT),
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: STO_PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        // An HTML page in place of the JSON reply is the gateway's block page.
        if (decodeText(bytes.subarray(0, 512)).trimStart().startsWith('<')) {
          throw new ChallengeError(STO_PROVIDER, 'STO answered with a web page instead of tracking data');
        }
        return parseSto(parseJsonBytes(bytes, STO_PROVIDER), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(STO_PROVIDER, 'STO tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new StoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'sto', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeStoNumber(number))) };
};
