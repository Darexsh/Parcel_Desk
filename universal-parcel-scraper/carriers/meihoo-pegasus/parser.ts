import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { meihooPegasusStage } from './status.js';

export const PROVIDER = 'MeiHoo Pegasus';
export const MEIHOO_PEGASUS_ORIGIN = 'http://129.204.184.34:8082';

// A row without a place that leads with one: a town and its province, then a postcode, then the wording.
const LEAD = /^(\p{L}[\p{L}\p{M} .'’-]*?)\s+(?:\d{4,6}(?:-\d{3,4})?|\d{2}-\d{3})\s+(?=\p{L})/u;

/**
 * The delivery row has no place of its own: it leads with the recipient's
 * town, province and postcode. When the wording after them is one the map
 * knows, the town and province become the row's place and the postcode is
 * dropped.
 */
export function splitMeihooPegasusRow(content: string, location: string): { content: string; location: string } {
  const lead = location.trim() ? null : LEAD.exec(content);
  const wording = lead ? content.slice(lead[0].length) : '';
  return lead && meihooPegasusStage(null, normalizeStatusWording(wording)) ? { content: wording, location: lead[1]! } : { content, location };
}

export const MEIHOO_PEGASUS: HualeiTenant = { carrier: 'meihoo-pegasus', provider: PROVIDER, origin: MEIHOO_PEGASUS_ORIGIN,
  stage: meihooPegasusStage, split: splitMeihooPegasusRow };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseMeihooPegasusTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, MEIHOO_PEGASUS, readAt);
export const parseMeihooPegasusPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, MEIHOO_PEGASUS, readAt);
