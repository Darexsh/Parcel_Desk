import type { AdapterFactory } from '../../core/adapter/index.js';
import { TM4WebTracker } from './tm4web.js';
import { MARITIME_ONTARIO } from './parser.js';

export class MaritimeOntarioTracker extends TM4WebTracker {
  constructor(options: ConstructorParameters<typeof TM4WebTracker>[1] = {}) { super(MARITIME_ONTARIO, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MaritimeOntarioTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'maritime-ontario', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
