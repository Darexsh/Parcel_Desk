import type { CarrierResult } from '../../core/result/index.js';
import { normalizeSpxNumber, parseSpxOrder, type SpxNetwork } from '../spx-id/regional.js';
import { statusMap } from './status.js';

// `en` is the tracker's own language.
export const SPX_SG: SpxNetwork = {
  id: 'spx-sg', provider: 'SPX Express Singapore', origin: 'https://spx.sg',
  language: 'en', spx: /^SPXSG\d{11}[0-9A-Z]$/, sls: /^SG\d{12}[0-9A-Z]$/, statuses: statusMap,
};

export const normalizeSpxSgNumber = (raw: string): string => normalizeSpxNumber(SPX_SG, raw);
export const parseSpxSg = (payload: unknown, raw: string): CarrierResult => parseSpxOrder(SPX_SG, payload, raw);
