import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HualeiTracker } from '../gzyl/hualei.js';
import { dateMayiyinfuScans, MAYIYINFU } from './parser.js';

export class MayiyinfuTracker extends HualeiTracker {
  constructor(options: ConstructorParameters<typeof HualeiTracker>[1] = {}) { super(MAYIYINFU, options); }

  override async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    return dateMayiyinfuScans(await super.fetch(raw, context));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MayiyinfuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'mayiyinfu', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
