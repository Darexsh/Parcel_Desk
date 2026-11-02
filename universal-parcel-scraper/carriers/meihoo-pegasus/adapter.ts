import type { AdapterFactory } from '../../core/adapter/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { MEIHOO_PEGASUS } from './parser.js';

export class MeihooPegasusTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(MEIHOO_PEGASUS, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MeihooPegasusTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'meihoo-pegasus', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
