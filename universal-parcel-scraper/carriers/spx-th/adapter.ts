import type { AdapterFactory } from '../../core/adapter/index.js';
import { spxOrderApi, spxRegionalAdapter } from '../spx-id/regional.js';
import { SPX_TH } from './parser.js';

/** The lookup the tracker on spx.co.th makes for the number in its address. */
export const SPX_TH_API = spxOrderApi(SPX_TH);

export const adapter: AdapterFactory = spxRegionalAdapter(SPX_TH);
