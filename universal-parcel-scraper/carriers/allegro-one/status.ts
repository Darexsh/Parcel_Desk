import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's English status wordings. The service sends no status code, so
 * each scan is staged by its wording. A parcel goes to a locker, a pickup point
 * or the recipient's door, Allegro's own or, for Allegro Delivery, a partner
 * network's; the history does not say which.
 */
export const ALLEGRO_ONE_SCANS: Readonly<Record<string, Stage>> = {
  // The sender made the label; Allegro One has not handled the parcel yet.
  'Parcel has been prepared by the sender': 'registered',
  // The sender dropped the parcel in a locker or at a point.
  'Parcel has been dispatched': 'accepted',
  'Parcel has been dispatched at point': 'accepted',
  'Parcel has been picked up by the courier': 'accepted',
  // A courier collected the sender's drop-off from the locker or the point.
  // After the parcel has waited at a point for its recipient, the parser reads
  // a courier's collection as the parcel taken back, to the sender or onward.
  'Parcel has been picked up from parcel locker by courier': 'accepted',
  'Parcel has been picked up from point by courier': 'accepted',
  'Courier has transferred the parcel to the warehouse': 'in_transit',
  'Parcel has been dispatched to its destination point': 'in_transit',
  'Parcel has been accepted at the sorting center': 'in_transit',
  'Parcel has been accepted at the delivery center': 'in_transit',
  'Parcel has been accepted at the destination center': 'in_transit',
  'Dispatched from sorting center': 'in_transit',
  'Parcel has been accepted at the branch': 'in_transit',
  'Parcel has been redirected to a different point': 'in_transit',
  // Notices while the parcel is on its way; neither stops it.
  'Parcel may be delivered with delay': 'in_transit',
  'Parcel delivery time has been arranged with the recipient': 'in_transit',
  'Parcel has been released for delivery': 'out_for_delivery',
  // The courier found the locker full and keeps the parcel.
  'No space in the parcel locker': 'failed_attempt',
  // The courier could not leave the parcel at the chosen point and takes it back.
  'Destination pick-up point is not available': 'failed_attempt',
  // The recipient turned the parcel away at the door; the parcel seen with it was delivered later.
  'Recipient has refused to accept': 'failed_attempt',
  // "Awizo": nobody took the parcel at the door and a notice was left.
  Notice: 'failed_attempt',
  // The recipient is asked to choose another point.
  'Parcel is waiting for an alternative point indication': 'exception',
  'Parcel is awaiting pick-up': 'ready_for_pickup',
  'Parcel is awaiting pick-up — pick-up deadline is about to expire': 'ready_for_pickup',
  'Time for pick-up has been extended': 'ready_for_pickup',
  'Time for parcel pick-up has expired': 'exception',
  // The parcel was not where a scan expected it; a later scan can find it again.
  'No parcel': 'exception',
  'Parcel has been lost': 'exception',
  // The parcel is sent back; the parser reads a return under way while later scans still move it.
  'Parcel has been returned to the sender': 'returned',
  'Parcel has been delivered': 'delivered',
};

/**
 * The tracker's Polish wordings, as it gives them for `pl-PL`, with the English
 * it gives the same scans for `en-US`. Each scan is staged by its English. The
 * Polish of "Recipient has refused to accept" has not been seen.
 */
export const ALLEGRO_ONE_POLISH: Readonly<Record<string, string>> = {
  'Przesyłka została przygotowana przez nadawcę': 'Parcel has been prepared by the sender',
  'Przesyłka została nadana': 'Parcel has been dispatched',
  'Przesyłka została nadana w punkcie': 'Parcel has been dispatched at point',
  'Przesyłka została odebrana przez kuriera': 'Parcel has been picked up by the courier',
  'Przesyłka została podjęta z maszyny przez kuriera': 'Parcel has been picked up from parcel locker by courier',
  'Przesyłka została podjęta z punktu przez kuriera': 'Parcel has been picked up from point by courier',
  'Kurier przekazał przesyłkę do magazynu': 'Courier has transferred the parcel to the warehouse',
  'Przesyłka wyjechała w drogę do punktu docelowego': 'Parcel has been dispatched to its destination point',
  'Przesyłka została przyjęta w sortowni': 'Parcel has been accepted at the sorting center',
  'Przesyłka została przyjęta w oddziale nadawczym': 'Parcel has been accepted at the delivery center',
  'Przesyłka została przyjęta w oddziale doręczającym': 'Parcel has been accepted at the destination center',
  'Wysłana z sortowni': 'Dispatched from sorting center',
  'Przesyłka została przyjęta w oddziale': 'Parcel has been accepted at the branch',
  'Przesyłka została przekierowana do innego punktu': 'Parcel has been redirected to a different point',
  'Przesyłka może zostać doręczona z opóźnieniem': 'Parcel may be delivered with delay',
  'Termin doręczenia przesyłki został ustalony z odbiorcą': 'Parcel delivery time has been arranged with the recipient',
  'Przesyłka została wydana do doręczenia': 'Parcel has been released for delivery',
  'Brak miejsca w maszynie': 'No space in the parcel locker',
  'Wybrany punkt docelowy jest niedostępny': 'Destination pick-up point is not available',
  Awizo: 'Notice',
  'Przesyłka oczekuje na wyznaczenie punktu alternatywnego': 'Parcel is waiting for an alternative point indication',
  'Przesyłka oczekuje na odbiór': 'Parcel is awaiting pick-up',
  'Przesyłka oczekuje na odbiór - zbliża się termin odbioru paczki': 'Parcel is awaiting pick-up — pick-up deadline is about to expire',
  'Czas na odbiór został przedłużony': 'Time for pick-up has been extended',
  'Skończył się czas na odbiór przesyłki': 'Time for parcel pick-up has expired',
  'Brak przesyłki': 'No parcel',
  'Przesyłka została zagubiona': 'Parcel has been lost',
  'Przesyłka została zwrócona do nadawcy': 'Parcel has been returned to the sender',
  'Przesyłka została doręczona': 'Parcel has been delivered',
};

// Both by `normalizeStatusWording` form.
const ENGLISH = new Map(Object.entries(ALLEGRO_ONE_POLISH).map(([polish, english]) => [normalizeStatusWording(polish), normalizeStatusWording(english)]));
const SCANS = new Map(Object.entries(ALLEGRO_ONE_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const PICK_UP_EXPIRED = normalizeStatusWording('Time for parcel pick-up has expired');

/** The English the tracker gives a scan it words in Polish, both in `normalizeStatusWording` form. */
export function allegroOneEnglish(wording: string): string | undefined {
  return ENGLISH.get(wording);
}

/** A wording's English, in `normalizeStatusWording` form. */
const english = (wording: string) => {
  const key = normalizeStatusWording(wording);
  return ENGLISH.get(key) ?? key;
};

/** The stage a scan's wording, English or Polish, gives it, if any. */
export function allegroOneStage(wording: string): Stage | undefined {
  return SCANS.get(english(wording));
}

/** Whether a scan says the recipient's time to collect the parcel at its point ran out. */
export function allegroOnePickUpExpired(wording: string): boolean {
  return english(wording) === PICK_UP_EXPIRED;
}

/** The tracker's scans carry a wording and no status code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(ENGLISH.get(wording) ?? wording),
  gaps: [],
};
