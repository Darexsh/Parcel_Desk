import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The titles the tracking page gives its scans, seen in histories. They name
 * the shipment statuses of Hovership's API, such as `POSSESSION`; the API's
 * exception and return statuses have not been seen on the page and fall to
 * the shared wording rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['label created', 'registered'], // The shipper made the label; Hovership has not scanned the parcel.
  ['in possession', 'accepted'], // Scanned in at a Hovership sort facility.
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The page's headline over the history, the parcel's current status. */
const HEADLINES: ReadonlyMap<string, Stage> = new Map([
  ['in our possession', 'accepted'],
  ['delivered', 'delivered'],
]);

const key = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The stage a scan's title gives. */
export function hovershipLabelStage(label: string): Stage | undefined {
  return LABELS.get(key(label));
}

/** The stage the page's headline gives the parcel. */
export function hovershipHeadlineStage(headline: string): Stage | undefined {
  return HEADLINES.get(key(headline));
}

/** A scan's stage: its title, else the shared wording rules on the title, then on its line, else nothing. */
export function hovershipStage(label: string, detail: string): ClassifiedWording | null {
  const mapped = hovershipLabelStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const text of [label, detail]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? hovershipLabelStage(code) : undefined),
  gaps: [],
};
