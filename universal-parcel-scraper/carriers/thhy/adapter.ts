import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { THHY, normalizeThhyNumber } from './parser.js';

export class ThhyTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(THHY, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ThhyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'thhy', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeThhyNumber(number))),
  };
};
