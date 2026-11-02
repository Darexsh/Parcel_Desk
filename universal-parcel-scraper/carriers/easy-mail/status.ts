import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case without accents or final sigma, so either spelling the tracker uses matches. */
function key(wording: string): string {
  return wording.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/**
 * The scans on Easy Mail's tracker, in Greek without a code. A store
 * (κατάστημα) is an Easy Mail branch: the pickup store (κατάστημα παραλαβής)
 * takes the parcel from the sender, the delivery store (κατάστημα παράδοσης)
 * delivers it. Older scans spell "arrived" Αφίχθει, newer ones Αφίχθη.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^καταχωρηση αποστολησ(?: απο τον αποστολεα)?$/, 'registered'],
  // A pickup order for the courier, booked with the shipment.
  [/^δημιουργηθηκε εντολη παραλαβησ$/, 'registered'],
  [/^χαρακτηρισμοσ ωσ παρεληφθη$/, 'accepted'],
  [/^το παρελαβε ο διανομεασ$/, 'accepted'],
  // A parcel the sender brings to a store: it comes with the pickup mark, before any departure.
  [/^αφιχθ(?:ει|η) στο καταστημα παραλαβησ$/, 'accepted'],
  [/^βρισκεται στο καταστημα παραλαβησ$/, 'accepted'],
  [/^αναχωρηση για το καταστημα παραδοσησ$/, 'in_transit'],
  [/^αφιχθ(?:ει|η) στο κεντρο διαλογησ$/, 'in_transit'],
  [/^αφιχθ(?:ει|η) στο καταστημα παραδοσησ$/, 'in_transit'],
  // Back at the delivery store after a round that did not deliver.
  [/^βρισκεται στο καταστημα παραδοσησ$/, 'in_transit'],
  [/^προσ παραδοση$/, 'out_for_delivery'],
  // Not delivered because the recipient collects the parcel at the store.
  [/^καταχωρηθηκε αιτια μη παραδοσησ, παραλαβη απο καταστημα$/, 'ready_for_pickup'],
  // A non-delivery reason, alone or followed by its name.
  [/^καταχωρηθηκε αιτια μη παραδοσησ(?:, .+)?$/, 'failed_attempt'],
  [/^παραδοθηκε$/, 'delivered'],
];

/** The stage a scan's wording gives it, if any. */
export function easyMailStage(wording: string): Stage | undefined {
  const text = key(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** Scans come without a code. Every wording seen gets a stage, so no gap is declared. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? easyMailStage(wording) : undefined),
  gaps: [],
};
