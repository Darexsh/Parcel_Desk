import type { AdapterFactory } from '../../core/adapter/index.js';
import { spxOrderApi, spxRegionalAdapter } from '../spx-id/regional.js';
import { SPX_SG } from './parser.js';

/** The lookup the tracker on spx.sg makes for the number in its address. */
export const SPX_SG_API = spxOrderApi(SPX_SG);

export const adapter: AdapterFactory = spxRegionalAdapter(SPX_SG);
