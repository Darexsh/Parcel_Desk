import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of DX Freight's tracker, which carry no codes. Only wordings
 * seen on the page are mapped; another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['data received', 'registered'], // The sender's consignment details reached DX; nothing is scanned yet.
  ['scan at delivery depot', 'in_transit'], // Scanned at a depot, the sending one included.
]);
// "Scanned 1 of 2 items onto delivery vehicle."
const LOADED = /^scanned (\d{1,4}) of (\d{1,4}) items? onto delivery vehicle\.?$/;
// "1 of 1 items delivered.", once the signatory's name is cut.
const DELIVERED = /^(\d{1,4}) of (\d{1,4}) items? delivered\.?$/;

/** The stage DX's wording gives a scan. */
export function dxMappedStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(text);
  if (mapped) return mapped;
  if (LOADED.test(text)) return 'out_for_delivery';
  const delivered = DELIVERED.exec(text);
  if (!delivered) return undefined;
  const [count, total] = [Number(delivered[1]), Number(delivered[2])];
  if (count === total && total > 0) return 'delivered';
  // Part of a consignment of several items: the rest are still on their way.
  return count < total ? 'in_transit' : undefined;
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function dxStage(wording: string): ClassifiedWording | null {
  const mapped = dxMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no codes: the map reads their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : dxMappedStage(wording)),
  gaps: [],
};
