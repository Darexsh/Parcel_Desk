import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The Hungarian wording of Magyar Posta's tracker, which the adapter asks for.
 * Each scan also carries the tracker's category, the code the adapter keeps:
 * 1 acceptance, 2 processing, 3 transport, 4 delivery and 5 delivered. The
 * wording refines it: an item announced by its sender is registered, one that
 * cannot be delivered and goes back is returned, and a delivery to the sender
 * is a return.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // Announced by the sender; processing starts once it is handed over.
  ['a küldeményt a feladó előrejelezte, az átadást követően megkezdjük a feldolgozást', 'registered'],
  ['postára beszállítás folyamatban', 'accepted'],
  ['a küldeményt a feladótól átvettük', 'accepted'],
  ['felvétel a feladótól', 'accepted'],
  ['a küldemény feldolgozás alatt', 'in_transit'],
  ['a küldemény feldolgozása folyamatban', 'in_transit'],
  ['feldolgozás alatt', 'in_transit'],
  ['küldemény előkészítése nemzetközi szállításra', 'in_transit'],
  ['a küldemény előkészítése nemzetközi szállításra', 'in_transit'],
  ['a bejövő küldemény átvétele a kicserélőben', 'in_transit'],
  // Customs asks the recipient for information, then clears the item.
  ['a vámkezeléshez szükséges információk bekérése (ügyfélre vár)', 'customs'],
  ['vámkezelés vége', 'in_transit'],
  // Duties and fees to pay online, then paid.
  ['online fizetés elérhető', 'customs'],
  ['sikeres online fizetés', 'in_transit'],
  ['címzetti rendelkezés - kézbesítési nap módosítása', 'in_transit'],
  ['címzetti rendelkezés - kézbesítési időpont meghatározása', 'in_transit'],
  ['címzetti rendelkezés - cím módosítása', 'in_transit'],
  ['címzetti rendelkezés - csomag elutasítása, visszaküldés', 'returned'],
  ['a küldemény szállítás alatt', 'in_transit'],
  ['járat indítás - egyéb', 'in_transit'],
  ['járat érkeztetés - feldolgozás', 'in_transit'],
  ['tartalmazó egységképző érkeztetés', 'in_transit'],
  ['egységképző átvétele (resdes)', 'in_transit'],
  ['továbbítás belföldre', 'in_transit'],
  ['a küldemény továbbítása kézbesítésre', 'in_transit'],
  ['a küldemény csomagautomatából postára szállítva', 'in_transit'],
  ['a küldemény csomagautomatából postára szállítva (műszaki hiba miatt)', 'in_transit'],
  ['a küldemény csomagautomatából postára szállítva (lejárt őrzési idő miatt)', 'in_transit'],
  ['utánküldés új címre (megrendelés alapján)', 'in_transit'],
  ['továbbítás másik kézbesítő postára (címzetti rendelkezés alapján)', 'in_transit'],
  ['ismételt kézbesítésre továbbítás új címre', 'in_transit'],
  ['a küldemény szállítás alatt (ismételt kézbesítésre)', 'in_transit'],
  // Undeliverable and kept as unclaimed mail.
  ['a küldemény nem kézbesíthető (megőrzésre továbbítva)', 'exception'],
  ['a küldemény nem kézbesíthető (címzett és feladó ismeretlen), megőrzésre továbbítva', 'exception'],
  // Undeliverable and on its way back to the sender.
  ['a küldemény nem kézbesíthető (sérülés miatt)', 'returned'],
  ['a küldemény nem kézbesíthető (a feladó visszakérte)', 'returned'],
  ['a küldemény nem kézbesíthető (cég megszűnt)', 'returned'],
  ['a küldemény nem kézbesíthető (elköltözött)', 'returned'],
  ['a küldemény nem kézbesíthető (átvételt megtagadta)', 'returned'],
  ['a küldemény nem kézbesíthető (hibás vagy hiányos címzés)', 'returned'],
  ['a küldemény nem kézbesíthető (ismeretlen címzett)', 'returned'],
  ['a küldemény nem kézbesíthető (nem kereste)', 'returned'],
  ['a küldemény nem kézbesíthető (nincs jogosult átvevő)', 'returned'],
  ['a küldemény nem kézbesíthető (kézbesítés akadályozott)', 'returned'],
  ['telefonos egyeztetés címzettel', 'out_for_delivery'],
  ['másnapi kézbesítésre előkészítve (címzett kérésére)', 'in_transit'],
  // Assigned to a courier at the delivery office, before the courier has the item.
  ['kézbesítőhöz rendelve', 'in_transit'],
  ['a küldemény a kézbesítőnél van', 'out_for_delivery'],
  ['sikertelen kézbesítés', 'failed_attempt'],
  // A PostaPont announces the time it can hand the item over.
  ['a küldemény postaponton 14:00 után átvehető', 'in_transit'],
  ['a küldemény postán átvehető', 'ready_for_pickup'],
  ['a küldemény postán átvehető (értesítőn szereplő dátumtól)', 'ready_for_pickup'],
  ['a küldemény csomagautomatából átvehető (az sms/email-ben kapott kóddal)', 'ready_for_pickup'],
  ['postaponton átvehető', 'ready_for_pickup'],
  ['sikeres kézbesítés', 'delivered'],
  ['sikeresen kézbesítve', 'delivered'],
  ['sikeresen kézbesítve háznál', 'delivered'],
  ['sikeresen kézbesítve postahelyen', 'delivered'],
  ['sikeresen kézbesítve postaponton', 'delivered'],
  ['sikeresen kézbesítve csomagautomatából', 'delivered'],
  ['sikeres kézbesítés rögzítése belső rendszerben', 'delivered'],
  ['feladónak visszakézbesítve', 'returned'],
]);

/** Category stages for wording the map does not know. Delivery (4) covers several milestones. */
const CATEGORIES: Readonly<Record<string, Stage>> = { '1': 'accepted', '2': 'in_transit', '3': 'in_transit', '5': 'delivered' };

/** Cash-on-delivery settlement with the sender, after the delivery: it moves nothing, and the adapter leaves it out. */
const SETTLEMENT = new Set(['árufizetési összeg feladónak kifizetve', 'árufizetési összeg részleges vagy teljes visszavonása']);
// The official list files it under waiting for collection, while its wording reads as a failed delivery.
const LOCKER_FAILURE = 'sikertelen kézbesítés csomagautomatából';

export function isMagyarPostaSettlement(wording: string): boolean {
  return SETTLEMENT.has(normalizeStatusWording(wording));
}

/** The stage of a scan's category (`1` to `5`) and wording, if they give one. */
export function magyarPostaStage(code: string | null, wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (SETTLEMENT.has(normalized) || normalized === LOCKER_FAILURE) return undefined;
  return STAGES.get(normalized) ?? (code && Object.hasOwn(CATEGORIES, code) ? CATEGORIES[code] : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: magyarPostaStage,
  gaps: [
    ...[...SETTLEMENT].map(wording => ({ code: '5', wording,
      note: 'Cash-on-delivery settlement with the sender after the delivery. It moves nothing; the adapter leaves it out.' })),
    { code: '4', wording: LOCKER_FAILURE,
      note: 'The official list files it under waiting for collection, while its wording reads as a failed delivery from a parcel locker.' },
  ],
};
