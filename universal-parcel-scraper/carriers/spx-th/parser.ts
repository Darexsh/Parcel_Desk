import type { CarrierResult } from '../../core/result/index.js';
import { normalizeSpxNumber, parseSpxOrder, type SpxNetwork } from '../spx-id/regional.js';
import { statusMap } from './status.js';

// `th` is the tracker's own language.
export const SPX_TH: SpxNetwork = {
  id: 'spx-th', provider: 'SPX Express Thailand', origin: 'https://spx.co.th',
  language: 'th', spx: /^SPXTH\d{11}[0-9A-Z]$/, sls: /^TH\d{12}[0-9A-Z]?$/, statuses: statusMap,
};

export const normalizeSpxThNumber = (raw: string): string => normalizeSpxNumber(SPX_TH, raw);
export const parseSpxTh = (payload: unknown, raw: string): CarrierResult => parseSpxOrder(SPX_TH, payload, raw);
