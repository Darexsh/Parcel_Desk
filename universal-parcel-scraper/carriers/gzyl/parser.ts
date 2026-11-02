import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from './hualei.js';
import { gzylStage, PLACED_WORDINGS, TOWN } from './status.js';

export const PROVIDER = 'GZYL';
export const GZYL_ORIGIN = 'http://134.175.243.207:8082';

/**
 * GZYL writes the town of a sorting centre, or of the parcel's way, after some
 * wordings ("Leaving the sorting center Town") and leaves the row's place
 * empty. The town becomes the place, so a wording reads the same for every
 * town; other rows stay whole.
 */
export function splitGzylRow(content: string, location: string): { content: string; location: string } {
  const text = content.trim().split(/\s+/).join(' ');
  for (const wording of PLACED_WORDINGS) {
    if (text.slice(0, wording.length + 1).toLowerCase() !== `${wording.toLowerCase()} `) continue;
    const town = text.slice(wording.length + 1);
    if (!TOWN.test(town)) break;
    const own = location.trim();
    return { content: text.slice(0, wording.length), location: own && own.toLowerCase() !== town.toLowerCase() ? `${town}, ${own}` : town };
  }
  return { content, location };
}

export const GZYL: HualeiTenant = { carrier: 'gzyl', provider: PROVIDER, origin: GZYL_ORIGIN, stage: gzylStage, split: splitGzylRow };

export const normalizeGzylNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseGzylTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, GZYL, readAt);
export const parseGzylPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, GZYL, readAt);
