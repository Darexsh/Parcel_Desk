import type { AdapterFactory } from '../../core/adapter/index.js';
import { CourierPortalTracker } from './portal.js';
import { CARRIER, LOGISIMPLE } from './parser.js';

export class LogisimpleTracker extends CourierPortalTracker {
  constructor(options: ConstructorParameters<typeof CourierPortalTracker>[1] = {}) { super(LOGISIMPLE, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LogisimpleTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
