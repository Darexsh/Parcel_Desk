import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { MTSCN, normalizeMtscnNumber } from './parser.js';

export class MtscnTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(MTSCN, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MtscnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mtscn', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeMtscnNumber(number))),
  };
};
