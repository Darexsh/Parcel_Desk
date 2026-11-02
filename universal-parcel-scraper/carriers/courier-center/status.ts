import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case without accents, final sigma or a closing full stop, so either casing the page uses matches. */
function key(wording: string): string {
  return wording.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/**
 * The scans on Courier Center's tracker, in Greek without a code. A shop
 * (κατάστημα) is a Courier Center branch or hub, the delivery station
 * (σταθμός παράδοσης) the branch that delivers, and a piece (τεμάχιο) one
 * parcel of the waybill, named by its number. Older pages write the same
 * scans in capitals. The rows a partner relays, BOX NOW's and ELTA's, keep
 * that partner's wording.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  // The sender's order, booked on the website before any parcel moves.
  [/^επιβεβαιωμενη παραγγελια$/, 'registered'],
  [/^παραλαβη ολων των τεμαχιων τησ αποστολησ στο καταστημα παραλαβησ(?:: .+)?$/, 'accepted'],
  [/^αφιξη αποστολησ στο καταστημα παραλαβησ$/, 'accepted'],
  [/^η παραλαβη τησ αποστολησ πραγματοποιηθηκε$/, 'accepted'],
  [/^το τεμαχιο νο[.:]? ?\[?[a-z0-9]+\]? ενταχθηκε στον? σακο$/, 'in_transit'],
  [/^αναχωρηση απο καταστημα$/, 'in_transit'],
  [/^η αποστολη αναχωρησε απο το σταθμο$/, 'in_transit'],
  [/^αφιξη τεμαχιου νο[.:]? ?[a-z0-9]+ στο καταστημα(?: παραλαβησ: .+)?$/, 'in_transit'],
  [/^αφιξη τεμαχιου στο σταθμο παραδοσησ(?: .+)?$/, 'in_transit'],
  [/^αφιξη (?:στο|σε) σταθμο παραδοσησ$/, 'in_transit'],
  [/^η αποστολη βρισκεται σε διακινηση$/, 'in_transit'],
  // Handed to EASYMAIL's network, which delivers it.
  [/^αναθεση προσ διαχειριση στο δικτυο τησ easymail$/, 'in_transit'],
  // ELTA's leg: sent on from one of its sorting or delivery offices.
  [/^σε εξαγωγη$/, 'in_transit'],
  // BOX NOW's leg: in its network on the way to the locker, then in the locker.
  [/^η αποστολη εχει αφιχθει στο δικτυο τησ box now και βρισκεται σε διακινηση προσ την θυριδα$/, 'in_transit'],
  [/^η αποστολη εχει αφιχθει στην θυριδα box now$/, 'ready_for_pickup'],
  [/^αναθεση αποστολησ για παραδοση σε διανομεα$/, 'out_for_delivery'],
  [/^σε διανομεα προσ παραδοση$/, 'out_for_delivery'],
  // Followed by the reason and the date, as "Αποτυχία παράδοσης, Αιτιολογία: …".
  [/^αποτυχια παραδοσησ(?:[ ,:].*)?$/, 'failed_attempt'],
  [/^η αποστολη παραδοθηκε στον παραληπτη$/, 'delivered'],
  [/^παραδοθηκε απο διανομεα$/, 'delivered'],
  [/^η αποστολη εχει παραδοθει$/, 'delivered'],
  [/^παραδοθηκε$/, 'delivered'],
];

/** The stage a scan's wording gives it, if any. */
export function courierCenterStage(wording: string): Stage | undefined {
  const text = key(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * The shipment's status over the history, "(29) DeliveryCompleted", by its
 * name. Only the first five settle the current stage over the scans: a parcel
 * still moving keeps its status while its scans go on.
 */
const SUMMARY: Readonly<Record<string, Stage>> = {
  deliverycompleted: 'delivered',
  returnbacktoshipper: 'returned',
  // Paid for as lost or damaged, or on its way to be.
  compensated: 'exception',
  refundprocess: 'exception',
  checkedinatcleverpoint: 'ready_for_pickup',
  // A piece was put in a bag.
  bagassigned: 'in_transit',
  // The page reads it as the sender not having handed the parcel over yet.
  none: 'registered',
};
const SETTLING = new Set(['deliverycompleted', 'returnbacktoshipper', 'compensated', 'refundprocess', 'checkedinatcleverpoint']);

/** The stage the summary status gives the shipment, and whether it settles the current stage. */
export function courierCenterSummaryStage(name: string): { stage: Stage; settles: boolean } | undefined {
  const status = name.toLowerCase();
  const stage = Object.hasOwn(SUMMARY, status) ? SUMMARY[status] : undefined;
  return stage ? { stage, settles: SETTLING.has(status) } : undefined;
}

const NOTICE = 'A message to the recipient, not a movement: the parcel keeps the stage it had.';

/**
 * Scans come without a code; a summary-only answer carries the summary's
 * number as its code and its name as its wording. Messages to the recipient,
 * the recipient's own instructions and a payment link move nothing.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? courierCenterStage(wording) : courierCenterSummaryStage(wording.trim())?.stage),
  gaps: [
    { wording: normalizeStatusWording('Εστάλη μήνυμα ενημέρωσης για σημερινή παράδοση της αποστολής'), note: NOTICE },
    { wording: normalizeStatusWording('Εστάλη μήνυμα για την δυνατότητα αναδρομολόγησης σε Clever Point'), note: NOTICE },
    { wording: normalizeStatusWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'), note: NOTICE },
    { wording: normalizeStatusWording('Προσπάθεια Επικοινωνίας με παραλήπτη'), note: 'A call to the recipient; it moves nothing.' },
    { wording: normalizeStatusWording('Παραλαβή από κατάστημα – εντολή παραλήπτη'),
      note: 'The recipient\'s instruction to collect the parcel at the delivery station, given through Courier Center\'s assistant; the collection is a later scan.' },
    { wording: normalizeStatusWording('ΑΙΤΗΜΑ ΠΑΡΑΛΑΒΗΣ ΑΠΟ ΚΑΤΑΣΤΗΜΑ'), note: 'The recipient\'s request to collect the parcel at a shop; it moves nothing.' },
    { wording: normalizeStatusWording('ΔΗΜΙΟΥΡΓΗΘΗΚΕ ΣΥΝΔΕΣΜΟΣ ΗΛΕΚΤΡΟΝΙΚΗΣ ΠΛΗΡΩΜΗΣ'), note: 'A payment link for the recipient; it moves nothing.' },
  ],
};
