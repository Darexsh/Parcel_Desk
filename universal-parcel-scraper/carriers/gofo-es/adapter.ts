import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { RegionalGofoTracker } from '../gofo-fr/adapter.js';
import { normalizeGofoSpainNumber, parseGofoSpain } from './parser.js';

export class GofoSpainTracker extends RegionalGofoTracker {
  constructor(options: ConstructorParameters<typeof RegionalGofoTracker>[2] = {}) { super('ES', parseGofoSpain, options); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GofoSpainTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gofo-es', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGofoSpainNumber(number))) };
};
