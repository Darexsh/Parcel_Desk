import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { normalizeWiioNumber, WIIO } from './parser.js';

export class WiioTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(WIIO, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WiioTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'wiio', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeWiioNumber(number))),
  };
};
