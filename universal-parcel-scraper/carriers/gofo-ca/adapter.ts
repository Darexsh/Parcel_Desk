import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { GofoTracker } from '../gofo/adapter.js';
import { GOFO_CANADA, normalizeGofoNumber } from '../gofo/parser.js';

export const adapter: AdapterFactory = environment => {
  const tracker = new GofoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent }, GOFO_CANADA);
  return { id: 'gofo-ca', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGofoNumber(number, GOFO_CANADA))) };
};
