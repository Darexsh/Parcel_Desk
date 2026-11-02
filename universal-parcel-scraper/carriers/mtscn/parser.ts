import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { mtscnStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

export const PROVIDER = 'Meiteshun Logistics';
export const MTSCN_ORIGIN = 'http://182.254.194.208:8082';

// The script's wordings, longest first, so that a short one never cuts a longer one short.
const WORDINGS = statuses.entries.map((entry) => entry.wording).sort((a, b) => b.length - a.length);
// A destination row ends with the recipient's town, a comma and the postcode.
const POSTCODE_TAIL = /\s*,[^,]*\d[^,]*$/;
// "ShenZhen,", "Hong Kong, ", "US,": the place a row starts with, and its comma.
const PLACE_HEAD = /^(\p{Lu}{2}|\p{Lu}\p{L}*(?: \p{Lu}\p{L}*)*)\s*,\s*$/u;
// Before a wording the script did not have, only a country code is taken for a place.
const COUNTRY_HEAD = /^(\p{Lu}{2})\s*,\s*(?=\S)/u;
// "Town", "Georgia", "ENG", "PT-15": the town or region after the wording.
const AREA = /^\p{Lu}[\p{L}\p{N} .'-]*$/u;

/**
 * A row's text is its place, a comma and the script's wording, and a
 * destination row adds the recipient's town or region after the wording, then
 * the postcode: `US,Arrive at the sorting and distribution center Town,00000`.
 * The wording stays as the script writes it; the place is the town or region,
 * then the row's own place. The postcode is never kept, and text around a
 * wording that is not a place leaves the row whole.
 */
export function splitMtscnRow(content: string, location: string): { content: string; location: string } {
  const text = content.trim();
  const lower = text.toLowerCase();
  for (const wording of WORDINGS) {
    const at = lower.indexOf(wording.toLowerCase());
    if (at < 0) continue;
    const head = at ? PLACE_HEAD.exec(text.slice(0, at))?.[1] : '';
    const tail = text.slice(at + wording.length).replace(POSTCODE_TAIL, '').trim();
    if (head === undefined || (tail && !AREA.test(tail))) break;
    const place = [tail, head].filter(Boolean).join(', ');
    return { content: text.slice(at, at + wording.length), location: place || location };
  }
  // A wording the script did not have yet: its country, if it starts with one, and no postcode.
  const rest = text.replace(POSTCODE_TAIL, '');
  const head = COUNTRY_HEAD.exec(rest);
  return head ? { content: rest.slice(head[0].length), location: head[1]! } : { content: rest, location };
}

export const MTSCN: HualeiTenant = { carrier: 'mtscn', provider: PROVIDER, origin: MTSCN_ORIGIN, stage: mtscnStage, split: splitMtscnRow };

export const normalizeMtscnNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseMtscnTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, MTSCN, readAt);
export const parseMtscnPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, MTSCN, readAt);
