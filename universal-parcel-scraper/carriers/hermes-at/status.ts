import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan wordings of the myHermes.at tracker, which carries no codes. The
 * scans Hermes Germany and Austrian Post make on the way come in the same
 * German wordings. Only wordings seen on the tracker are mapped; another falls
 * to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Sendung wurde Hermes elektronisch angekündigt', 'registered'],
  ['Sendung vom Kunden am PaketShop abgegeben', 'accepted'],
  // The PaketShop handed the parcel to the collecting service.
  ['Sendung an Dienstleister übergeben', 'in_transit'],
  ['Eingang Logistikzentrum', 'in_transit'],
  ['Sendung in Sortierung', 'in_transit'],
  // The address was keyed in again during sorting; the parcel goes on.
  ['Adressnacherfassung', 'in_transit'],
  // Handed to the network that carries it on, before sorting and delivery in Germany.
  ['Sendung an Transportpartner übergeben', 'in_transit'],
  ['Eingang Zustellbasis', 'in_transit'],
  // A return label's parcel goes forward to the merchant under this wording too.
  ['Retoure im Logistikzentrum sortiert', 'in_transit'],
  ['Sendung in Zustellung', 'out_for_delivery'],
  ['Empfänger nicht angetroffen - benachrichtigt', 'failed_attempt'],
  // A notice left and the parcel taken to a post office; the post office's own scan follows.
  ['Empfänger benachrichtigt / Sendung wurde hinterlegt', 'failed_attempt'],
  ['Sendung in Post-Geschäftsstelle abholbereit', 'ready_for_pickup'],
  ['Sendung am Postamt hinterlegt', 'ready_for_pickup'],
  // Put in an Austrian Post receiving box, which the recipient opens to take it out:
  // Austrian Post's tracker gives the same scan as ready for collection.
  ['Sendung in Postempfangsbox zugestellt', 'ready_for_pickup'],
  ['Sendung aus Postempfangsbox entnommen', 'delivered'],
  ['Sendung zugestellt', 'delivered'],
  ['Sendung an Empfänger übergeben', 'delivered'],
  ['Sendung an Angestellten/Kollegen des Empfängers übergeben', 'delivered'],
  ['Sendung im Rückversand', 'returned'],
  ['Rücksendung - Sendung beschädigt', 'exception'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function hermesAtMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function hermesAtStage(wording: string): ClassifiedWording | null {
  const mapped = hermesAtMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => hermesAtMappedStage(wording),
  gaps: [],
};
