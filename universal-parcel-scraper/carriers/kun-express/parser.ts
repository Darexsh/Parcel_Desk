import type { CarrierResult } from '../../core/result/index.js';
import { escapeRegExp } from '../../core/transport/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressStage } from './status.js';

export const PROVIDER = 'Kun Express';
export const KUN_EXPRESS_ORIGIN = 'http://1.117.249.36:8082';

// USPS's explanation of a row, which the tracker copies after an arrow. It repeats the
// place, and on a delivery the recipient's town and ZIP code.
const EXPLANATION = /\s+->(?:\s[\s\S]*)?$/u;
// A ZIP code ending a place, with or without its four-digit add-on.
const ZIP = /\s+\d{5}(?:-\d{4})?$/u;

/**
 * A row copied from USPS can lead with its place and end with USPS's
 * explanation after an arrow. Both are cut, and the place's commas are spaced
 * one way, so the copies of one scan read alike. The place's ZIP code is dropped.
 */
export function splitKunExpressRow(content: string, location: string): { content: string; location: string } {
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const text = content.replace(EXPLANATION, '').trim();
  const lead = parts.length ? new RegExp(`^${parts.map(escapeRegExp).join('\\s*,\\s*')}\\s*,\\s*`, 'u') : null;
  return { content: lead ? text.replace(lead, '') : text, location: parts.join(', ').replace(ZIP, '') };
}

/**
 * Kun Express writes its own rows to the second, on the platform's Beijing
 * clock. The rows it copies from USPS come to the minute on the facility's
 * clock, as USPS's explanation of them shows, and keep their wall clocks; one
 * at midnight carries only its day.
 */
export function kunExpressClock(row: HualeiRow): 'platform' | 'wall' | 'day' {
  if (!row.clock.endsWith(':00')) return 'platform';
  return row.clock.endsWith(' 00:00:00') ? 'day' : 'wall';
}

/**
 * The tracker can copy one USPS scan three times: alone, after its place, and
 * with USPS's explanation, which can add the scan's category before it
 * ("On the Way, Arrived at USPS Facility"). At one clock and place, a wording
 * that ends with another after a comma is that scan again.
 */
export const repeatsKunExpressRow = (wording: string, other: string): boolean => wording.endsWith(`, ${other}`);

export const KUN_EXPRESS: HualeiTenant = { carrier: 'kun-express', provider: PROVIDER, origin: KUN_EXPRESS_ORIGIN, stage: kunExpressStage,
  split: splitKunExpressRow, clock: kunExpressClock, repeats: repeatsKunExpressRow };

/** The track interface's reply, or null when it holds no row for the number. */
export const parseKunExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, KUN_EXPRESS, readAt);
export const parseKunExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, KUN_EXPRESS, readAt);
