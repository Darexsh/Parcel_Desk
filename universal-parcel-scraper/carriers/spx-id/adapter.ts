import type { AdapterFactory } from '../../core/adapter/index.js';
import { SPX_ID } from './parser.js';
import { spxOrderApi, spxRegionalAdapter } from './regional.js';

/** The lookup the tracker on spx.co.id makes for the number in its address. */
export const SPX_ID_API = spxOrderApi(SPX_ID);

export const adapter: AdapterFactory = spxRegionalAdapter(SPX_ID);
