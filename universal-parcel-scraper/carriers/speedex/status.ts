import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of the scans on Speedex's tracker, in Greek capitals and without
 * a code. A shop (κατάστημα) is a Speedex branch and Δ/Κ a distribution centre.
 * The voucher waits for the sender until the first pickup or shop scan.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  'ΑΝΑΜΟΝΗ ΑΝΑΘΕΣΗΣ ΑΠΟ ΑΠΟΣΤΟΛΕΑ': 'registered',
  'ΠΑΡΑΛΑΒΗ ΑΠΟ ΑΠΟΣΤΟΛΕΑ': 'accepted',
  'ΠΑΡΑΛΑΒΗ ΣΤΟ ΚΑΤΑΣΤΗΜΑ': 'accepted',
  'ΕΞΑΓΩΓΗ ΑΠΟ ΚΑΤΑΣΤΗΜΑ': 'in_transit',
  'ΕΙΣΑΓΩΓΗ ΣΕ Δ/Κ': 'in_transit',
  'ΕΞΑΓΩΓΗ ΑΠΟ Δ/Κ': 'in_transit',
  'ΕΙΣΑΓΩΓΗ ΣΕ ΚΑΤΑΣΤΗΜΑ': 'in_transit',
  // Put on a courier's round.
  'ΔΡΟΜΟΛΟΓΗΣΗ': 'in_transit',
  // Held at the branch, as after a missed delivery.
  'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΜΕΝΕΙ ΣΤΟ ΣΤΑΘΜΟ': 'in_transit',
  'ΠΡΟΣ ΠΑΡΑΔΟΣΗ': 'out_for_delivery',
  // The recipient was not in.
  'ΑΠΩΝ': 'failed_attempt',
  // The sender is told the parcel could not be delivered.
  'ΕΝΗΜΕΡΩΣΗ ΑΠΑΡΑΔΟΤΗΣ ΑΠΟΣΤΟΛΗΣ': 'exception',
  // An undelivered parcel sent back; the history seen ends at the head office's reception.
  'ΕΠΙΣΤΡΟΦΗ ΑΠΑΡΑΔΟΤΟΥ': 'returned',
  // The summary card the page puts under the scans of a delivered parcel.
  'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΔΟΘΗΚΕ': 'delivered',
};

/** Wording in `normalizeStatusWording` form; the page writes ΑΠΟ with and without its accent. */
function key(wording: string): string {
  return normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, ''));
}

const SCAN_KEYS = new Map(Object.entries(SCANS).map(([wording, stage]) => [key(wording), stage]));

/** The stage a scan's wording gives it, if any. */
export function speedexStage(wording: string): Stage | undefined {
  return SCAN_KEYS.get(key(wording));
}

const NOTICE = 'A message to the recipient, not a movement: the parcel keeps the stage it had.';

/**
 * Scans carry wording only. Messages to the recipient, the cancellation of a
 * shop scan and a customer's instruction to collect at the branch move nothing.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? speedexStage(wording) : undefined),
  gaps: [
    { wording: normalizeStatusWording('ΕΠΙΤΥΧΗΣ ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ (VIBER)'), note: NOTICE },
    { wording: normalizeStatusWording('ΑΠΟΤΥΧΙΑ ΕΝΗΜΕΡΩΣΗΣ (VIBER)'), note: 'A message to the recipient that did not go through; the parcel keeps the stage it had.' },
    { wording: normalizeStatusWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ (SMS)'), note: NOTICE },
    { wording: normalizeStatusWording('ΑΝΑΚΛΗΣΗ ΕΙΣΑΓΩΓΗΣ ΣΕ ΚΑΤΑΣΤΗΜΑ'),
      note: 'Cancels a shop scan, between two routings of the same round; it moves nothing.' },
    { wording: normalizeStatusWording('ΠΑΡΑΛΑΒΗ ΑΠΟ ΣΤΑΘΜΟ - ΕΝΤΟΛΗ ΠΕΛΑΤΗ'),
      note: 'A customer\'s instruction to collect the parcel at the branch, seen between a delivery round and the delivery; it moves nothing.' },
  ],
};
