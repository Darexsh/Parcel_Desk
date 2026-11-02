import type { AdapterFactory } from '../../core/adapter/index.js';
import { spxOrderApi, spxRegionalAdapter } from '../spx-id/regional.js';
import { SPX_VN } from './parser.js';

/** The lookup the tracker on spx.vn makes for the number in its address. */
export const SPX_VN_API = spxOrderApi(SPX_VN);

export const adapter: AdapterFactory = spxRegionalAdapter(SPX_VN);
