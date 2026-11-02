import type { CarrierResult } from '../../core/result/index.js';
import { normalizeSpxNumber, parseSpxOrder, type SpxNetwork } from './regional.js';
import { statusMap } from './status.js';

// `id` is the tracker's own language. Its delivery line names who took the parcel, which is dropped.
export const SPX_ID: SpxNetwork = {
  id: 'spx-id', provider: 'SPX Express Indonesia', origin: 'https://spx.co.id',
  language: 'id', spx: /^SPXID\d{11}[0-9A-Z]$/, sls: /^ID\d{12}[0-9A-Z]?$/, statuses: statusMap,
};

export const normalizeSpxIdNumber = (raw: string): string => normalizeSpxNumber(SPX_ID, raw);
export const parseSpxId = (payload: unknown, raw: string): CarrierResult => parseSpxOrder(SPX_ID, payload, raw);
