import type { CarrierResult } from '../../core/result/index.js';
import { lexNumber, parseLexSearch, type LexTenant } from '../lex-id/lex.js';

/** LEX Malaysia's site, on the platform LEX Indonesia's runs on. Its numbers are TMYLE and nine digits. */
export const LEX_MY: LexTenant = {
  carrier: 'lex-my', provider: 'LEX Malaysia', origin: 'https://lex.com.my', timezone: 'Asia/Kuala_Lumpur',
  asked: (number) => (/^TMYLE\d{9}$/.test(number) ? number : null),
  shape: 'TMYLE and nine digits',
};

export const normalizeLexMyNumber = (raw: string): string => lexNumber(LEX_MY, raw);
export const parseLexMySearch = (payload: unknown, raw: string): CarrierResult => parseLexSearch(payload, normalizeLexMyNumber(raw), LEX_MY);
