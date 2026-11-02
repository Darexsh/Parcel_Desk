import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { RegionalGofoTracker } from '../gofo-fr/adapter.js';
import { normalizeGofoItalyNumber, parseGofoItaly } from './parser.js';

export class GofoItalyTracker extends RegionalGofoTracker {
  constructor(options: ConstructorParameters<typeof RegionalGofoTracker>[2] = {}) { super('IT', parseGofoItaly, options); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GofoItalyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gofo-it', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGofoItalyNumber(number))) };
};
