import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan wordings the tracker prints, in Russian and without a code, each
 * read up to the office the reply names after it.
 *
 * The first two are the UPU's IPS event names, relayed from the sending
 * post's electronic data with "Офис:" and the office after them. Kyrgyz
 * Post's own scans are a verb, then the office, as "Поступило в отделение
 * связи …" (arrived at a post office) or "Отправлено из ЦМПОЛ в заграницу"
 * (sent abroad from the international exchange).
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  // Receive item at office of exchange (Otb).
  [/^получить отправление в сортировочном узле \(исход\.\)/, 'in_transit'],
  // Insert item into bag (Otb).
  [/^вложить отправление в мешок \(исх\.\)/, 'in_transit'],
  // Taken in at a post office.
  [/^принято в /, 'accepted'],
  // Arrived at the exchange, a sorting office or the post office that delivers it.
  [/^поступило в /, 'in_transit'],
  [/^отправлено из /, 'in_transit'],
  [/^вручено получателю(?:$|[\s,:;.])/, 'delivered'],
];
// Customs is not among the places seen; a scan naming it is left to the shared rules.
const CUSTOMS = /таможн/;

/** The stage the map gives a scan's wording, if it knows it. */
export function kyrgyzPostWordingStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  if (CUSTOMS.test(key)) return undefined;
  return WORDINGS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A scan's stage from the map, else the shared wording rules, else nothing, which keeps it visible for review. */
export function kyrgyzPostStage(wording: string): ClassifiedWording | null {
  const mapped = kyrgyzPostWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no code; the wording alone sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : kyrgyzPostWordingStage(wording)),
  gaps: [],
};
