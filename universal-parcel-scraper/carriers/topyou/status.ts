import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { imileSentenceStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/**
 * TopYou's scan status codes, as its tracker labels them. 15 also marks the
 * delivery carrier's scans up to the delivery, out for delivery included, so
 * it says no more than that the parcel moves.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0', 'registered'], // 预上网: announced, not yet received.
  ['5', 'accepted'], // 头程入库: booked in at the first-mile warehouse.
  ['10', 'in_transit'], // 头程出库: out of the first-mile warehouse.
  ['13', 'in_transit'], // 转运: transferred.
  ['15', 'in_transit'], // 运输途中: in transit.
  ['20', 'in_transit'], // 到达目的国家: arrived in the destination country.
  ['25', 'customs'], // 清关: in customs clearance.
  ['30', 'delivered'], // 已签收: signed for.
  ['35', 'exception'], // 投递异常: a delivery problem.
  ['40', 'returned'], // 退件: returned.
]);
// Codes that settle a scan whatever its wording says.
const DECISIVE = new Set(['30', '40']);

/**
 * iMile's step labels, with the codes iMile's own tracker gives them. TopYou
 * relays iMile's scans, in Germany for instance, as the label, a comma and
 * iMile's sentence: "Delivery, Our delivery associate is out for delivery."
 */
const IMILE_STEPS: ReadonlyMap<string, string> = new Map([
  ['order creation', '1001'], ['pick up', '2005'], ['received', '2004'],
  ['in transit', '1002'], ['delivery', '1003'], ['delivered', '2060'],
]);
const IMILE_RELAY = /^([a-z ]{5,14}), (?=\S)/i;

/**
 * The stage iMile's sentences give a scan TopYou relays from iMile, null for one that moves
 * nothing, undefined for any other scan, such as USPS's under a label of its own.
 */
function imileRelayStage(wording: string): Stage | null | undefined {
  const step = IMILE_RELAY.exec(wording);
  const code = step && IMILE_STEPS.get(step[1]!.toLocaleLowerCase('en-US'));
  return code ? imileSentenceStage(code, wording.slice(step[0].length)) : undefined;
}

// The delivery carrier's number, which the tracker appends to the first-mile
// warehouse's outbound scan on a line a post delivers: "…, Lastmile Number:LM…CN".
const LASTMILE = /\s*,\s*lastmile number\s*:\s*[a-z0-9]+$/i;

/** Whether TopYou relays the scan from iMile: iMile's step label and a sentence iMile's map knows. */
export const isImileRelay = (wording: string): boolean => imileRelayStage(wording) !== undefined;

/**
 * A scan's stage: its wording in TopYou's map, then a delivered or returned
 * code, then iMile's map for a scan relayed from iMile, then the shared
 * wording rules, then its code. Null for a scan without a stage, or one of
 * iMile's that moves nothing.
 */
export function topyouStage(code: string, wording: string): ClassifiedWording | null {
  const decided = WORDINGS.stage(normalizeStatusWording(wording.replace(LASTMILE, '')))
    ?? (DECISIVE.has(code) ? CODES.get(code) : undefined);
  const relayed = decided ? undefined : imileRelayStage(wording);
  if (relayed === null) return null;
  const mapped = decided ?? relayed;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  const coded = CODES.get(code);
  return coded ? { stage: coded, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => topyouStage(code ?? '', wording)?.stage,
  gaps: [],
  gapNote: (_code, wording) => (imileRelayStage(wording) === null
    ? 'A line iMile relays that moves nothing, such as a stock count: the parcel keeps the stage it had.' : undefined),
};
