import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { accepted, recognizeFromLookup } from '../../core/adapter/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeOntracRequest, parseOntrac } from './parser.js';

// Endpoint and schema come from the current official portal client:
// https://www.ontrac.com/wp-content/themes/ontrac/assets/js/ontrac-package-status.js
const ENDPOINT = 'https://webtrack.ontrac.com/PackageServices/tracking/';

export class OntracTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeOntracRequest(raw);
    return runSteps({ carrier: 'ontrac', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`${ENDPOINT}${encodeURIComponent(number)}`, {
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) }, signal,
      }, { provider: 'OnTrac', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      if (response.status === 404 || response.status === 410) {
        // The portal returns generic ProblemDetails for unknown numbers; the
        // same envelope can mean a missing API route rather than no parcel.
        throw new IndeterminateError('OnTrac', 'OnTrac could not return the tracking resource');
      }
      return parseOntrac(parseJsonBytes(bytes, 'OnTrac'), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OntracTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ontrac', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeOntracRequest(number))) };
};
