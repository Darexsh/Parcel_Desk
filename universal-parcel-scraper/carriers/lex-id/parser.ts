import type { CarrierResult } from '../../core/result/index.js';
import { lexNumber, parseLexSearch, type LexTenant } from './lex.js';

/**
 * LEX Indonesia's site. Its waybills are LXAD and ten digits, which the search
 * finds only with the hyphen after LXAD that detection removes.
 */
export const LEX_ID: LexTenant = {
  carrier: 'lex-id', provider: 'LEX Indonesia', origin: 'https://lex.co.id', timezone: 'Asia/Jakarta',
  asked: (number) => (/^LXAD\d{10}$/.test(number) ? `LXAD-${number.slice(4)}` : null),
  shape: 'LXAD and ten digits',
};

export const normalizeLexIdNumber = (raw: string): string => lexNumber(LEX_ID, raw);
export const parseLexIdSearch = (payload: unknown, raw: string): CarrierResult => parseLexSearch(payload, normalizeLexIdNumber(raw), LEX_ID);
