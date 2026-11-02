import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's status column: Qwintry's own codes, which also carry the
 * local carrier's scans, and the operation names Russian Post gives the scans
 * of the parcels Qwintry handed to the post. Another code falls to the
 * wording, then to the shared rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['info_received', 'registered'], // The sender's data; Qwintry does not have the parcel yet.
  ['arrival_scan', 'in_transit'],
  ['departure_scan', 'in_transit'],
  ['sorting', 'in_transit'],
  ['delivery', 'in_transit'], // Handed to the delivery service in the destination country; a delivery or pickup-point scan follows.
  ['delivering', 'out_for_delivery'],
  ['pickup_point', 'ready_for_pickup'],
  ['delivered', 'delivered'],
  ['problem', 'exception'],
  ['customs', 'customs'],
  ['приём', 'in_transit'], // Russian Post took the parcel over from Qwintry's partner in Europe.
  ['прием', 'in_transit'],
  ['экспорт международной почты', 'in_transit'],
  ['импорт международной почты', 'in_transit'],
  ['обработка', 'in_transit'],
  ['приём на таможню', 'customs'],
  ['прием на таможню', 'customs'],
  ['таможенное оформление', 'customs'],
  ['неудачная попытка вручения', 'failed_attempt'],
]);

/** Wordings that stage a scan whatever its code: under `info`, or a step a broader code covers. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Shipment arrived to consolidation hub', 'accepted'], // Qwintry's US hub has the parcel.
  ['Customs clearance completed', 'in_transit'],
  ['The shipment has left customs', 'in_transit'],
  ['Выпущено таможней', 'in_transit'], // Released by customs.
  ['Покинуло таможню.', 'in_transit'], // Left customs.
  ['Ваше отправление закончило таможенное оформление', 'in_transit'], // Customs clearance is over.
  ['Таможенное оформление в РФ', 'customs'], // Customs clearance in Russia.
  ['Передан локальному перевозчику', 'in_transit'], // Handed to the local carrier.
  ['Передано почтальону', 'out_for_delivery'], // With the postman.
  ['Выдан на доставку', 'out_for_delivery'], // Out with the local carrier's courier.
  ['Поступило в пункт выдачи', 'ready_for_pickup'], // At the pickup point.
  ['Принят на склад до востребования', 'ready_for_pickup'], // At the local carrier's office, to be collected.
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a status code, else its wording. */
export function qwintryMappedStage(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? (code ? CODES.get(code.trim().toLowerCase()) : undefined);
}

/** A scan's stage: its wording or code in the map, else the shared wording rules; a message to the recipient has none. */
export function qwintryStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = qwintryMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (/^notification_sent$/i.test(code.trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => qwintryMappedStage(code, wording),
  gaps: [
    { code: 'notification_sent', note: 'A message to the recipient, sometimes with the day the parcel should arrive; it moves nothing.' },
    { code: 'info', note: 'Qwintry\'s notes on delays and the local carrier\'s own steps, in free text; the map stages only the wordings it lists, and the parcel keeps the stage of its hand-off.' },
    { code: 'other', note: 'The local carrier\'s own steps, in free text; the map stages only the wordings it lists, and the parcel keeps the stage of its hand-off.' },
  ],
};
