import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scans of SGH Global Japan's SGX tracker, as its English and Japanese
 * pages word them. The page carries no codes. Only wording seen in replies is
 * mapped; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // At the origin station abroad.
  ['preparing for dispatch', 'accepted'],
  ['出荷準備中', 'accepted'],
  ['on board aircraft', 'in_transit'],
  ['現地へ輸送中', 'in_transit'],
  ['arrived at transit point', 'in_transit'],
  ['経由地を出発', 'in_transit'],
  // At the Japanese airport, then the bonded warehouse; the English page writes "Arrrived".
  ['arrrived at destination airport', 'in_transit'],
  ['現地空港に到着', 'in_transit'],
  ['in transit to our bonded warehouse', 'in_transit'],
  ['自社倉庫へ転送中', 'in_transit'],
  // In customs; the shorter English wording is the same scan on older pages.
  ['arrived at destination / customs clearance', 'customs'],
  ['arrived at destination', 'customs'],
  ['現地に到着/通関中', 'customs'],
  // Released by customs.
  ['clearance release', 'in_transit'],
  ['通関許可', 'in_transit'],
  // Sent on from the airport to Sagawa Express, which delivers about two days later; the
  // English page calls it "Out For Delivery".
  ['out for delivery', 'in_transit'],
  ['お荷物を発送しました', 'in_transit'],
  ['absence', 'failed_attempt'],
  ['不在', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['配達完了', 'delivered'],
  // The status column of the list of air waybills, in Japanese, English and Chinese.
  ['配達完了(delivered)(派送完毕，已签收)', 'delivered'],
]);

/** The flight's expected arrival, listed as a row of the history; it is a forecast, not a scan. */
const FORECASTS = new Set(['estimated arrival date at airport', 'フライト到着予定日']);
const FORECAST_NOTE = 'The flight\'s expected arrival at the Japanese airport, listed among the scans; a forecast, not a scan, so the parser drops the row.';

/** The stage the map gives a wording, if it knows it. */
export function sagawaGlobalMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** Whether a row is the flight's expected arrival rather than a scan. */
export function isSagawaGlobalForecast(wording: string): boolean {
  return FORECASTS.has(normalizeStatusWording(wording));
}

/** A wording's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function sagawaGlobalStage(wording: string): ClassifiedWording | null {
  const mapped = sagawaGlobalMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => sagawaGlobalMappedStage(wording),
  gaps: [...FORECASTS].map((wording) => ({ wording, note: FORECAST_NOTE })),
};
