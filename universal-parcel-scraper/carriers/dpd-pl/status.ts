import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English tracking page's scan wording, mapped whole. The shared
 * classifier misreads several of these, such as a parcel dispatched for
 * delivery or waiting at a pickup point.
 */
export const DPD_PL_SCANS: Readonly<Record<string, Stage>> = {
  'Registered parcel data, parcel not dispatched yet': 'registered',
  'Parcel dropped-off in pickup point': 'accepted',
  'Parcel received by DPD depot': 'in_transit',
  'Sent outside Poland': 'in_transit',
  // A short hold at a depot, seen before a pickup point run.
  'Parcel stored in depot': 'in_transit',
  'Parcel dispatched to be collected by pickup point': 'in_transit',
  'Parcel dispatched to be delivered': 'out_for_delivery',
  // The pickup point or locker received the parcel for the recipient.
  'Parcel collected by pickup point': 'ready_for_pickup',
  'The Parcel has been placed in the DPD Pickup Station': 'ready_for_pickup',
  'To be collected personally': 'ready_for_pickup',
  'Parcel not delivered - recipient not available': 'failed_attempt',
  'Parcel not delivered - wrong address': 'failed_attempt',
  'Not delivered to pickup point - overloaded': 'failed_attempt',
  // A refusal, a parcel nobody collected in time, and a return sent back
  // under a new parcel number: delivery stops, and none has reached the sender.
  'Parcel not delivered - recipient resigned': 'exception',
  'Waiting for pickup timeout': 'exception',
  'Parcel return': 'exception',
  'Parcel delivered': 'delivered',
};

// A courier's collection accepts the parcel from its sender. After an earlier
// acceptance or depot scan, as from the pickup point the sender dropped it at
// or from another country's network, it hands the parcel on.
const COLLECTIONS = ['Parcel collected by courier', 'Parcel collected'];

// Messages to the recipient: no movement, so the parcel keeps its stage.
const NOTICES = ['Mail notification', 'SMS notification', 'Sent notification'];

/**
 * The Polish page's wording, with the English the English page gives the same
 * scan. Each scan is staged by its English. The Polish page tells a scan
 * abroad apart where the English one words it as at home. The Polish of the
 * other English wordings has not been seen.
 */
export const DPD_PL_POLISH: Readonly<Record<string, string>> = {
  'Zarejestrowano dane przesyłki, przesyłka jeszcze nienadana': 'Registered parcel data, parcel not dispatched yet',
  'Nadanie przesyłki w punkcie Pickup': 'Parcel dropped-off in pickup point',
  'Przesyłka odebrana przez Kuriera': 'Parcel collected by courier',
  'Przyjęcie przesyłki w oddziale DPD': 'Parcel received by DPD depot',
  'Przekazano za granicę': 'Sent outside Poland',
  'Przeładunek w sortowni za granicą': 'Parcel received by DPD depot',
  'Przyjęcie przesyłki w oddziale doręczenia za granicą': 'Parcel received by DPD depot',
  'Wydanie przesyłki do doręczenia': 'Parcel dispatched to be delivered',
  'Wydanie do doręczenia za granicą': 'Parcel dispatched to be delivered',
  'Przyjęcie przesyłki do punktu Pickup': 'Parcel collected by pickup point',
  'Przesyłka niedoręczona - odbiorca nieobecny': 'Parcel not delivered - recipient not available',
  'Przesyłka niedoręczona - rezygnacja klienta z przesyłki': 'Parcel not delivered - recipient resigned',
  'Zwrot przesyłki': 'Parcel return',
  'Przesyłka doręczona': 'Parcel delivered',
  'Powiadomienie mail': 'Mail notification',
  'Powiadomienie SMS': 'SMS notification',
  'Wysłano powiadomienie': 'Sent notification',
};

// All by `normalizeStatusWording` form.
const ENGLISH = new Map(Object.entries(DPD_PL_POLISH).map(([polish, english]) => [normalizeStatusWording(polish), normalizeStatusWording(english)]));
const SCANS = new Map(Object.entries(DPD_PL_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const COLLECTION_KEYS = new Set(COLLECTIONS.map(normalizeStatusWording));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));

/** The English the English page gives a scan the Polish page words so, in `normalizeStatusWording` form. */
export function dpdPlEnglish(wording: string): string | undefined {
  return ENGLISH.get(normalizeStatusWording(wording));
}

/** A wording's English, in `normalizeStatusWording` form. */
const english = (wording: string) => {
  const key = normalizeStatusWording(wording);
  return ENGLISH.get(key) ?? key;
};

/** The stage the wording alone, English or Polish, gives a scan, if any. */
export function dpdPlScanStage(wording: string): Stage | undefined {
  return SCANS.get(english(wording));
}

/** A courier's collection, whose stage depends on the scans before it. */
export function isDpdPlCollection(wording: string): boolean {
  return COLLECTION_KEYS.has(english(wording));
}

export function isDpdPlNotice(wording: string): boolean {
  return NOTICE_KEYS.has(english(wording));
}

/**
 * What the map says about one scan. The page's scans carry wording only. A
 * collection's stage depends on the scans before it, so the map does not know
 * it from its wording; notices are left without a stage on purpose.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(ENGLISH.get(wording) ?? wording),
  gaps: [...NOTICE_KEYS, ...ENGLISH.keys()].filter(wording => isDpdPlNotice(wording)).map(wording => ({
    wording, note: 'A message to the recipient, not a movement: the parcel keeps the stage it had.',
  })),
};
