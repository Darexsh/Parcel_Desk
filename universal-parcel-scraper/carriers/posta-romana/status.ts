import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan wording, mapped whole. It writes Romanian without
 * diacritics, which the shared classifier does not read.
 */
export const POSTA_ROMANA_SCANS: Readonly<Record<string, Stage>> = {
  'Primit de la expeditor': 'accepted',
  'In prelucrare': 'in_transit',
  'In transport': 'in_transit',
  'Expediat din Romania': 'in_transit',
  'Sosit in Romania': 'in_transit',
  'Returnat catre expeditor': 'returned',
  // A notice follows, and the item can be collected at the office the scan names from that date.
  'Programat pentru predare incepand cu aceasta data': 'ready_for_pickup',
  'Predat la destinatar': 'delivered',
};

/** The wording in map form, also when it is written with diacritics: "În prelucrare". */
const key = (wording: string) => normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');

const SCANS = new Map(Object.entries(POSTA_ROMANA_SCANS).map(([wording, stage]) => [key(wording), stage]));

/** The stage Poșta Română's own wording gives a scan, if the map knows it. */
export function postaRomanaScanStage(wording: string): Stage | undefined {
  return SCANS.get(key(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function postaRomanaStage(wording: string): ClassifiedWording | null {
  const mapped = postaRomanaScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : postaRomanaScanStage(wording)),
  gaps: [],
};
