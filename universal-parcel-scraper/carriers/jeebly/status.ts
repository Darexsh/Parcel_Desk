import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Jeebly's status names, which the tracker shows above each scan's line and
 * its webhooks send as `status`. The tracker shows them as provider codes.
 * Names from the webhook documentation are mapped as well as those seen on
 * the tracker; another name falls to the shared wording rules.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['pickup scheduled', 'registered'],
  // Express: a rider is assigned to collect the order, then reaches the sender.
  ['assigned', 'registered'],
  ['reached pickup location', 'registered'],
  ['pickup completed', 'accepted'],
  ['picked up', 'accepted'],
  // The rider could not collect the parcel; it is still with the sender.
  ['not picked up', 'exception'],
  ['inscan at hub', 'in_transit'],
  ['reached at hub', 'in_transit'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['reached customer location', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['undelivered', 'failed_attempt'],
  ['on-hold', 'exception'],
  // The webhooks' sample spells it with an en dash.
  ['on – hold', 'exception'],
  // Marked for return to the sender, and on the way back.
  ['rto', 'exception'],
  ['rto delivered', 'returned'],
  ['cancelled', 'exception'],
]);

// A new delivery date, an edit of the order's details and a withdrawn rider move nothing.
const NO_MOVEMENT = new Set(['rescheduled', 'order updated', 'unassigned']);

/** The stage Jeebly's status names give a status name, in any case and spacing. */
export function jeeblyMappedStage(status: string): Stage | undefined {
  return STATUSES.get(normalizeStatusWording(status));
}

/** A scan's stage: its status name, else nothing for a name that moves nothing, else the shared wording rules. */
export function jeeblyStage(status: string, wording: string): ClassifiedWording | null {
  const mapped = jeeblyMappedStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NO_MOVEMENT.has(normalizeStatusWording(status))) return null;
  for (const text of [wording, status]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  codeKey: normalizeStatusWording,
  stage: (code) => (code ? jeeblyMappedStage(code) : undefined),
  gaps: [
    { code: 'rescheduled', note: 'A new delivery date, which the line names; the parcel does not move.' },
    { code: 'order updated', note: 'The sender edited the order\'s details; the parcel does not move.' },
    { code: 'unassigned', note: 'An express rider assignment withdrawn; the parcel does not move.' },
  ],
};
