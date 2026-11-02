import type { AdapterFactory } from '../../core/adapter/index.js';
import { GetOnlineTracker } from './getonline.js';
import { SKYNET } from './parser.js';

export { SKYNET_TRACKER } from './parser.js';

export class SkynetTracker extends GetOnlineTracker {
  constructor(options: ConstructorParameters<typeof GetOnlineTracker>[1] = {}) { super(SKYNET, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkynetTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skynet-worldwide', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
