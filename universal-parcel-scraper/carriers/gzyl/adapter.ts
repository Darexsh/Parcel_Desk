import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from './hualei.js';
import { GZYL, normalizeGzylNumber } from './parser.js';

export class GzylTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(GZYL, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GzylTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gzyl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGzylNumber(number))),
  };
};
