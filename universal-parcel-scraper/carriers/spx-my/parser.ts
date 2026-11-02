import type { CarrierResult } from '../../core/result/index.js';
import { normalizeSpxNumber, parseSpxOrder, type SpxNetwork } from '../spx-id/regional.js';
import { statusMap } from './status.js';

// The tracker's `en` lines name no one; its `ms` and `zh` lines put the recipient's name after a delivery.
export const SPX_MY: SpxNetwork = {
  id: 'spx-my', provider: 'SPX Express Malaysia', origin: 'https://spx.com.my',
  language: 'en', spx: /^SPXMY\d{11}[0-9A-Z]$/, sls: /^MY\d{12}[0-9A-Z]$/, statuses: statusMap,
};

export const normalizeSpxMyNumber = (raw: string): string => normalizeSpxNumber(SPX_MY, raw);
export const parseSpxMy = (payload: unknown, raw: string): CarrierResult => parseSpxOrder(SPX_MY, payload, raw);
