import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's scan wordings. Scans come without a code; another wording
 * falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The sender booked the parcel; LogoiX does not have it yet. The second
  // sentence comes on a line of its own in the same scan.
  ['Sendungsdaten wurden elektronisch erfasst.', 'registered'],
  ['Sendungsdaten wurden elektronisch erfasst. Der Versender hat die Sendung noch nicht bei LogoiX zum Versand eingeliefert.', 'registered'],
  ['Eingang Verteilzentrum LogoiX, in Bearbeitung', 'accepted'],
  ['Abfertigung LogoiX Zentrale Freilassing', 'accepted'],
  // Handed to the transport partner the page names next.
  ['Ausgang Verteilzentrum LogoiX', 'in_transit'],
  // DHL's wording, which the page once listed under the partner's number.
  ['Die Sendung wurde im Start-Paketzentrum bearbeitet.', 'in_transit'],
  ['Die Sendung wurde im Ziel-Paketzentrum bearbeitet.', 'in_transit'],
  ['Die Sendung wurde in das Zustellfahrzeug geladen.', 'out_for_delivery'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan wording. */
export function logoixMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function logoixStage(wording: string): ClassifiedWording | null {
  const mapped = logoixMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : logoixMappedStage(wording)),
  gaps: [],
};
