import type { CarrierResult } from '../../core/result/index.js';
import { normalizeSpxNumber, parseSpxOrder, type SpxNetwork } from '../spx-id/regional.js';
import { statusMap } from './status.js';

// `vi` is the tracker's own language.
export const SPX_VN: SpxNetwork = {
  id: 'spx-vn', provider: 'SPX Express Vietnam', origin: 'https://spx.vn',
  language: 'vi', spx: /^SPXVN\d{11}[0-9A-Z]$/, sls: /^VN\d{12}[0-9A-Z]$/, statuses: statusMap,
};

export const normalizeSpxVnNumber = (raw: string): string => normalizeSpxNumber(SPX_VN, raw);
export const parseSpxVn = (payload: unknown, raw: string): CarrierResult => parseSpxOrder(SPX_VN, payload, raw);
