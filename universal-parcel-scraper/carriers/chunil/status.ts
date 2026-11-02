import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The labels of the route table's 상태 (status) column, which are also the
 * values of the delivery result. Rows carry no code. The labels seen on the
 * tracker are mapped, with those an open-source Korean tracker lists for this
 * page; another label falls to the wording rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['접수', 'accepted'], // The sending branch took the parcel in.
  ['발송', 'in_transit'], // Sent on from the sending branch.
  ['발송터미널하차', 'in_transit'], // Unloaded at the origin terminal.
  ['발송터미널출발', 'in_transit'], // Left the origin terminal.
  ['간선상차', 'in_transit'], // Loaded onto a trunk-line truck.
  ['간선하차', 'in_transit'], // Unloaded from a trunk-line truck.
  ['중계도착', 'in_transit'], // Arrived at a relay terminal.
  ['중계발송', 'in_transit'], // Left a relay terminal.
  ['도착터미널하차', 'in_transit'], // Unloaded at the destination terminal.
  ['도착', 'in_transit'], // Arrived; the page's template places it before the terminal scans.
  ['영업소도착', 'in_transit'], // Arrived at the delivering branch.
  ['배송출발', 'out_for_delivery'], // Left the delivering branch for the recipient.
  ['배송완료', 'delivered'],
]);

/** The stage Chunil's labels give a status, if the map knows it. */
export function chunilMappedStage(label: string): Stage | undefined {
  return LABELS.get(label.replace(/\s/g, ''));
}

/** A status's stage: the map, else the shared wording rules, else nothing. */
export function chunilStage(label: string): ClassifiedWording | null {
  const mapped = chunilMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its label. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : chunilMappedStage(wording)),
  gaps: [],
};
