import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { jhgjStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

export const PROVIDER = 'Jiuhao International';
export const JHGJ_ORIGIN = 'http://119.29.157.172:8082';

// The script's wordings, longest first, so that a short one never cuts a longer one short.
const WORDINGS = statuses.entries.map((entry) => entry.wording).sort((a, b) => b.length - a.length);
// A row from China ends with its place in brackets: `邮件离开处理中心【广州市】`.
const BRACKETED = /^([^【】]*[^\s【】])\s*【([^【】]+)】$/u;
// After a wording, the postcode starts at the first word holding a digit: `Town 00-000`, `Town AB1 2CD`.
const POSTCODE = /(?:^|\s+)[\p{L}\p{N}-]*\d[\s\S]*$/u;
// "Town", "Nowy Dwór", "Saint-Étienne": the recipient's town after the wording.
const TOWN = /^\p{Lu}[\p{L}\p{M} .'’-]{0,59}$/u;
// A postcode ending a row whose wording the script did not have yet: `00-000`, `AB1 2CD`, `1234 AB`.
const POSTCODE_TAIL = /\s+(?=[\p{L}\p{N}-]*\d)[\p{Lu}\p{N}][\p{Lu}\p{N}-]*(?:\s[\p{Lu}\p{N}]{2,4})?$/u;

/**
 * A row's text is the script's wording, with its place in brackets on rows
 * from China, and the recipient's town and postcode after it on rows at the
 * destination: `Delivered Town 00-000`. The wording stays as the script writes
 * it and the place is the bracketed one or the town. The postcode is never
 * kept, and text after a wording that is not a town leaves the row whole.
 */
export function splitJhgjRow(content: string, location: string): { content: string; location: string } {
  const text = content.trim();
  const bracketed = BRACKETED.exec(text);
  if (bracketed) return { content: bracketed[1]!, location: bracketed[2]!.trim() || location };
  const lower = text.toLowerCase();
  const wording = WORDINGS.find((candidate) => lower.startsWith(candidate.toLowerCase())
    && (text.length === candidate.length || /\s/u.test(text[candidate.length]!)));
  if (wording) {
    const town = text.slice(wording.length).replace(POSTCODE, '').trim();
    if (!town || TOWN.test(town)) return { content: text.slice(0, wording.length), location: town || location };
  }
  // A wording the script did not have yet: the row whole, without a postcode.
  return { content: text.replace(POSTCODE_TAIL, ''), location };
}

/** Rows keep their wall clocks: the delivery row added later is on the destination's clock. */
export const JHGJ: HualeiTenant = { carrier: 'jhgj', provider: PROVIDER, origin: JHGJ_ORIGIN, stage: jhgjStage, split: splitJhgjRow, wallClocks: true };

export const normalizeJhgjNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseJhgjTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, JHGJ, readAt);
export const parseJhgjPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, JHGJ, readAt);
