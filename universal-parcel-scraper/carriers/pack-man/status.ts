import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case without accents or final sigma, so either spelling matches. */
function key(wording: string): string {
  return wording.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/**
 * The scans on Pack-Man's search page, in Greek without a code, and the short
 * names of the five stages the page explains under the form.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['εκκρεμει (προσ παραλαβη)', 'registered'], // Booked, waiting to be collected from the sender.
  ['εκκρεμει', 'registered'],
  ['εγινε παραλαβη απο pack-man courier', 'accepted'],
  ['παραλαβη', 'accepted'],
  // Through the sorting centre and scheduled for delivery.
  ['εχει δρομολογηθει για παραδοση', 'in_transit'],
  ['δρομολογηση', 'in_transit'],
  // Given to a driver, when the recipient gets an SMS with the delivery window.
  ['εγινε αναθεση σε οδηγο', 'out_for_delivery'],
  ['αναθεση σε οδηγο', 'out_for_delivery'],
  ['παραδοθηκε στον παραληπτη', 'delivered'],
  ['παραδοση', 'delivered'],
]);
// The invoicing steps the page lists after the delivery.
const BILLING = new Set(['προσ τιμολογηση', 'τιμολογημενη']);

/** The stage a scan's wording gives it, if any. */
export function packManStage(wording: string): Stage | undefined {
  return SCANS.get(key(wording));
}

/** Whether a scan is an invoicing step: billing, not the parcel's movement. */
export function isPackManBilling(wording: string): boolean {
  return BILLING.has(key(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? packManStage(wording) : undefined),
  gaps: [
    { wording: 'προς τιμολόγηση', note: 'An invoicing step after the delivery, which the adapter leaves out; it moves nothing.' },
    { wording: 'τιμολογημένη', note: 'An invoicing step after the delivery, which the adapter leaves out; it moves nothing.' },
  ],
};
