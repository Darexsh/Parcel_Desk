import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Česká pošta names each row with a state code. Numeric codes are the ones its
// ePOST documentation lists; codes with a leading dash and P codes are its
// tracking service's own, for data, sorting and Balíkovna steps.
const CODES: Readonly<Record<string, Stage>> = {
  // The sender's data, before Česká pošta has the item.
  '-M': 'registered',
  '-L': 'registered',
  '21': 'accepted',
  '-F': 'in_transit',
  '-I': 'in_transit',
  '-B': 'in_transit',
  '75': 'in_transit',
  // Reached the delivery office or depot, where it is prepared for delivery.
  '51': 'in_transit',
  '8D': 'in_transit',
  '8T': 'in_transit',
  '8U': 'in_transit',
  '8Z': 'in_transit',
  '53': 'out_for_delivery',
  // Waits at a post office, after a failed attempt or as addressed.
  '81': 'ready_for_pickup',
  '82': 'ready_for_pickup',
  'P2': 'ready_for_pickup',
  '91': 'delivered',
  '9V': 'returned',
  // A return under way, for the reason the code gives: not delivered and not back yet.
  '95': 'exception',
  '96': 'exception',
  '97': 'exception',
  '98': 'exception',
  '9B': 'exception',
  '9E': 'exception',
  'P3': 'exception',
  // Damaged.
  '8E': 'exception',
};

/** The codes that send an item back: a delivery after one reaches the sender. */
export const RETURN_STARTS: ReadonlySet<string> = new Set(['95', '96', '97', '98', '9B', '9E', 'P3']);

// Messages to the recipient and bookkeeping: no movement, so the item keeps its stage.
const NOTICES = new Map<string, string>([
  ['42', 'A text message to the recipient.'],
  ['43', 'An email to the recipient.'],
  ['QB', 'The courier\'s position at a delivery attempt, which is never read.'],
]);

// Codes whose meaning for the delivery is unclear, left without a stage.
const UNSTAGED = new Map<string, string>([
  ['88', 'The item left the register; the code does not say whether it moved on or was written off.'],
]);

export function ceskaPostaCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

export function isCeskaPostaNotice(code: string): boolean {
  return NOTICES.has(code);
}

/**
 * A row's stage from the code map, else from the shared wording rules. A code
 * neither knows stays without a stage, so it remains visible for review.
 */
export function ceskaPostaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = ceskaPostaCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every row carries its code, which alone gives the stage. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? ceskaPostaCodeStage(code) : undefined),
  gaps: [
    ...[...NOTICES].map(([code, note]) => ({ code, note: `${note} Not a movement: the item keeps the stage it had.` })),
    ...[...UNSTAGED].map(([code, note]) => ({ code, note })),
  ],
};
