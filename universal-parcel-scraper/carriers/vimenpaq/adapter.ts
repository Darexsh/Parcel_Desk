import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { ControlboxTracker } from './controlbox.js';
import { normalizeVimenpaqNumber, VIMENPAQ } from './parser.js';

export class VimenpaqTracker extends ControlboxTracker {
  constructor(options: ConstructorParameters<typeof ControlboxTracker>[1] = {}) { super(VIMENPAQ, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VimenpaqTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vimenpaq', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeVimenpaqNumber(number))),
  };
};
