import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * MaltaPost names each scan with a UPU event code (EMA to EMI, EDA to EDH),
 * its own wording and, after a hold or a failed delivery, a reason and an
 * action. The action decides what happens next, so the provider code carries
 * it: `EMH/E` is a failed delivery whose item goes back to its sender. Foreign
 * posts' events relayed to MaltaPost use the same codes.
 */
const CODES: Readonly<Record<string, Stage>> = {
  // UPU's posting event, which MaltaPost words as created; for an item from
  // abroad it is the foreign post's posting.
  EMA: 'accepted',
  EMB: 'in_transit',
  EMC: 'in_transit',
  EMD: 'in_transit',
  EDB: 'customs',
  EME: 'customs',
  // Back from the customs office: released.
  EDC: 'in_transit',
  EMF: 'in_transit',
  EMG: 'in_transit',
  EDG: 'out_for_delivery',
  EMH: 'failed_attempt',
  'EMH/C': 'failed_attempt',
  'EMH/E': 'returned',
  EDH: 'ready_for_pickup',
  EMI: 'delivered',
};

// The recipient's own steps on the tracking page: not movements.
const NOTICES = new Map<string, string>([
  ['Declaration', 'The recipient submitted the customs declaration online.'],
  ['Payment', 'The recipient paid the charges online.'],
  ['PRD', 'The online payment of the charges went through.'],
]);

// Scans that keep the stage the item had.
const HOLDS = new Map<string, string>([
  ['EDA', 'Held at the inward office of exchange; the reason says why, such as charges to pay.'],
  ['FWD', 'Forwarded between MaltaPost\'s own centres and offices, on the way in or back; the tracking page\'s progress bar ignores it.'],
]);

// The action that sends the item back to its sender.
const RETURN_TO_SENDER = 'EMH/E';

/** The event code without the action that follows it. */
function baseCode(code: string): string {
  return code.split('/')[0] ?? code;
}

export function isMaltaPostNotice(code: string): boolean {
  return NOTICES.has(baseCode(code));
}

/** Whether a scan keeps the stage the item had before it: a notice, a hold or a forwarding. */
export function keepsMaltaPostStage(code: string): boolean {
  return isMaltaPostNotice(code) || HOLDS.has(baseCode(code));
}

/** Whether the scan sends the item back to its sender: a delivery after it reaches the sender. */
export function returnsToSender(code: string): boolean {
  return code === RETURN_TO_SENDER;
}

/** The stage the code gives a scan: its own, else that of its event without the action. */
export function maltaPostCodeStage(code: string): Stage | undefined {
  if (keepsMaltaPostStage(code)) return undefined;
  if (Object.hasOwn(CODES, code)) return CODES[code];
  const base = baseCode(code);
  return base !== code && Object.hasOwn(CODES, base) ? CODES[base] : undefined;
}

/**
 * A scan's stage from its code, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function maltaPostStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = maltaPostCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (keepsMaltaPostStage(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries a code, with its action when it has one; the map reads the code alone. */
export const statusMap: CarrierStatusMap = {
  codeKey: baseCode,
  stage: code => (code ? maltaPostCodeStage(code) : undefined),
  gaps: [
    ...[...NOTICES].map(([code, note]) => ({ code, note: `${note} Not a movement: the item keeps the stage it had.` })),
    ...[...HOLDS].map(([code, note]) => ({ code, note: `${note} The item keeps the stage it had.` })),
  ],
};
