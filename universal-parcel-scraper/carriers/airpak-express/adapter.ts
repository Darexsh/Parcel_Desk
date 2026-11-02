import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { GetOnlineTracker } from '../skynet-worldwide/getonline.js';
import { AIRPAK, normalizeAirpakNumber } from './parser.js';

export class AirpakTracker extends GetOnlineTracker {
  constructor(options: ConstructorParameters<typeof GetOnlineTracker>[1] = {}) { super(AIRPAK, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AirpakTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'airpak-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeAirpakNumber(number))),
  };
};
