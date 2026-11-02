import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case without accents, final sigma or a closing full stop, so either casing matches. */
function key(wording: string): string {
  return wording.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
    .replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/**
 * The scans on Taxydema's tracker, in Greek without a code. A shop
 * (κατάστημα) is a Taxydema branch or hub, the delivery station (σταθμός
 * παράδοσης) the branch that delivers, and a piece (τεμάχιο) one parcel of the
 * waybill, named by its number. Only wordings seen in replies are mapped.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^παραλαβη ολων των τεμαχιων τησ αποστολησ στο καταστημα παραλαβησ(?:: .+)?$/, 'accepted'],
  [/^αναχωρηση απο καταστημα$/, 'in_transit'],
  [/^αφιξη τεμαχιου νο[.:]? ?[a-z0-9]+ στο καταστημα(?: παραλαβησ: .+)?$/, 'in_transit'],
  [/^αφιξη τεμαχιου στο σταθμο παραδοσησ(?: .+)?$/, 'in_transit'],
  [/^αναθεση αποστολησ για παραδοση σε διανομεα$/, 'out_for_delivery'],
  [/^η αποστολη παραδοθηκε στον παραληπτη$/, 'delivered'],
  // The tracker's earlier wording, with the date after it.
  [/^δημιουργια αποστολησ απο πελατη(?: \(.+\))?$/, 'registered'],
  [/^κλεισιμο σε συσκευασια$/, 'accepted'],
  [/^αφιξη σε κ\/δ .+$/, 'in_transit'],
  [/^παραλαβη απο σταθμο εξαγωγησ(?:[.\s].*)?$/, 'in_transit'],
  // Sent on through an outside partner's network for the last leg.
  [/^προωθηση μεσω δικτυου εξωτερικου συνεργατη$/, 'in_transit'],
  [/^παραδοθηκε με στοιχεια παραδοσησ$/, 'delivered'],
  [/^παραδοθηκε$/, 'delivered'],
  // The page's progress steps; the last reads as a return for a parcel going back.
  [/^δημιουργια αποστολησ$/, 'registered'],
  [/^παραλαβη$/, 'accepted'],
  [/^σε διακινηση$/, 'in_transit'],
  [/^αφιξη στο σταθμο παραδοσησ$/, 'in_transit'],
  [/^προσ παραδοση$/, 'out_for_delivery'],
  [/^παραδοση$/, 'delivered'],
  [/^επιστροφη στον αποστολεα$/, 'returned'],
];

/** The stage a scan's wording gives it, if any. */
export function taxydemaStage(wording: string): Stage | undefined {
  const text = key(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** Scans come without a code. A message to the recipient moves nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? taxydemaStage(wording) : undefined),
  gaps: [
    { wording: normalizeStatusWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'),
      note: 'A message to the recipient, not a movement: the parcel keeps the stage it had.' },
  ],
};
