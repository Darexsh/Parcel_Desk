import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Posta Shqiptare's tracker words each scan in Albanian. Its own scans add the
 * IPS event name in English after a slash; the scans it relays from a foreign
 * post, and from the courier that carries some EMS items abroad, have the
 * Albanian wording alone. The scans carry no code. The map reads the Albanian
 * wording, without accents, since the relayed scans are written without them
 * and the courier's with them.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['pranim objekti nga klienti', 'accepted'],
  // Taken out of its bag at a post office or sorting centre in Albania after the posting,
  // though its English half says inbound.
  ['objekti u nxor nga thesi per perpunim', 'in_transit'],
  // The foreign post's office of exchange received it.
  ['objekti u pranua ne zyren e shkembimit', 'in_transit'],
  // Presented to customs, or held there, in the destination country.
  ['regjistrimi i informacionit doganor te objektit', 'customs'],
  // Sent on from the office of exchange.
  ['objekti u dergua ne zyren destinacion', 'in_transit'],
  ['objekti u pranua ne zyren e shperndarjes', 'in_transit'],
  ['tentative e pasuksesshme ne shperndarjen e objektit', 'failed_attempt'],
  ['objekti u dorezua', 'delivered'],
  // The courier's scans.
  ['nisur nga origjina', 'in_transit'],
  ['mbajtur ne dogane', 'customs'],
  ['mberritur ne qendren e shperndarjes', 'in_transit'],
  // Seen between the arrival at the delivery centre and the delivery; it does not say the item went out.
  ['marre nga korrieri', 'in_transit'],
  ['dorezuar', 'delivered'],
]);

/** The Albanian wording, before the English half, without accents. */
const albanianOf = (wording: string) =>
  normalizeStatusWording(wording).split(/\s+\/(?:\s|$)/, 1)[0]!.normalize('NFD').replace(/\p{Mn}/gu, '');

/** The stage the map gives Posta Shqiptare's wording, if it knows it. */
export function postaShqiptareScanStage(wording: string): Stage | undefined {
  return STAGES.get(albanianOf(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function postaShqiptareStage(wording: string): ClassifiedWording | null {
  const mapped = postaShqiptareScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : postaShqiptareScanStage(wording)),
  gaps: [],
};
