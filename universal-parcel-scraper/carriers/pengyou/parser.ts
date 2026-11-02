import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { TOWN } from '../gzyl/status.js';
import { pengyouStage } from './status.js';

export const PROVIDER = 'Pengyou';
export const PENGYOU_ORIGIN = 'http://120.77.149.241:8082';

// The last-mile delivery, with its town after it: "Delivered Sample Town ST".
const DELIVERED = /^(delivered) (\p{L}.*)$/iu;
// The postal code a delivery's town can end with, after a space or glued on: Canada's "A1A 1A1",
// the United Kingdom's "AA1A 1AA", a United States ZIP code, and four to six digits elsewhere.
const POSTCODE = /\s*(?:[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{5}-\d{4}|\d{4,6})$/iu;

/**
 * Pengyou writes the town of a last-mile delivery after its wording and leaves
 * the row's place empty. The town becomes the place, without the recipient's
 * postal code, so a delivery reads the same for every town. A town that keeps a
 * digit once its postal code is cut stays in the wording.
 */
export function splitPengyouRow(content: string, location: string): { content: string; location: string } {
  const match = DELIVERED.exec(content.trim().split(/\s+/).join(' '));
  if (!match || location.trim()) return { content, location };
  const town = match[2]!.replace(POSTCODE, '').trim();
  if (!town || /\d/.test(town) || !TOWN.test(town)) return { content, location };
  return { content: match[1]!, location: town };
}

export const PENGYOU: HualeiTenant = { carrier: 'pengyou', provider: PROVIDER, origin: PENGYOU_ORIGIN, stage: pengyouStage, split: splitPengyouRow };

export const normalizePengyouNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parsePengyouTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, PENGYOU, readAt);
export const parsePengyouPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, PENGYOU, readAt);
