import type { AdapterFactory } from '../../core/adapter/index.js';
import { spxOrderApi, spxRegionalAdapter } from '../spx-id/regional.js';
import { SPX_MY } from './parser.js';

/** The lookup the tracker on spx.com.my makes for the number in its address. */
export const SPX_MY_API = spxOrderApi(SPX_MY);

export const adapter: AdapterFactory = spxRegionalAdapter(SPX_MY);
