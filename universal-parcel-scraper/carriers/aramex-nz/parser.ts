import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { normalizeAramexNumber, parseAramex, type AramexNetwork } from '../aramex-au/parser.js';
import { aramexNzStage } from './status.js';

export const PROVIDER = 'Aramex New Zealand';

/**
 * A parcel Aramex hands on to NZ Post for a rural delivery: the reply flags it
 * and carries NZ Post's label, which the page links to NZ Post's tracker. The
 * label counts only when NZ Post's detection takes it whole.
 */
function nzPostHandoff(result: Record<string, unknown>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (result.IsNZPostOnforward !== true || typeof result.OnforwardLabelNumber !== 'string') return {};
  const label = normalizeTrackingNumber(result.OnforwardLabelNumber.slice(0, 64));
  return /^[A-Z0-9]{4,40}$/.test(label) && detectCarrierMatch(label).candidates.includes('nz-post')
    ? { delivery_carrier: 'nz-post', delivery_tracking_number: label } : {};
}

// The page script's codes of a scan handing the parcel on to another carrier.
const HANDED_ON = new Set(['CR1', 'B63', 'DVR', 'ONF', 'RUR', 'NP1']);

// Aramex New Zealand runs Aramex Australia's tracker on its own host and
// database. Its page shows every scan, with no place for those before pickup,
// and every depot keeps New Zealand's clock.
const NEW_ZEALAND: AramexNetwork = {
  provider: PROVIDER,
  sscc: false,
  hidden: new Set(),
  placeless: new Set(['IOC', 'PP0', 'PP2', 'PP3', 'PP4', 'PP5', 'PP7']),
  // A courier's run is named after its area and numbered: the area is the place.
  place: (name) => name.replace(/\s+Zone\s+\d+$/i, ''),
  stage: aramexNzStage,
  zone: 'Pacific/Auckland',
  priority: false,
  // The page shows the estimate only with both depots known, and shows a notice
  // instead once the newest scan hands the parcel on to another carrier.
  showsEstimate: (result, rows) => typeof result.PickupFranchiseCode === 'string' && result.PickupFranchiseCode.trim() !== ''
    && !HANDED_ON.has(String((rows.at(-1) as { Status?: unknown } | undefined)?.Status)),
  handoff: nzPostHandoff,
};

/** A number as the tracker looks it up: upper case, without spaces or dashes. */
export function normalizeAramexNzNumber(raw: string): string {
  return normalizeAramexNumber(raw, NEW_ZEALAND);
}

/** The reply of Aramex New Zealand's tracking service for one number. */
export function parseAramexNz(payload: unknown, raw: string): CarrierResult {
  return parseAramex(payload, raw, NEW_ZEALAND);
}
