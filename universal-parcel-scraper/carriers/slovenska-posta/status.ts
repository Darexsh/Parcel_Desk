import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Slovenská pošta names each event with a code. Its own network's codes are
// the ones its T&T REST API manual lists; a cross-border item's UPU events
// come as IPS_ and the UPU letters, with a suffix for the direction (THERE on
// the way out, BACK on the way back) or a reason.
const CODES: Readonly<Record<string, Stage>> = {
  PODOD: 'accepted',
  PODODA: 'accepted',
  PREK: 'accepted',
  PREBB: 'accepted',
  PODOU: 'in_transit',
  VDOIO: 'in_transit',
  VSTUP: 'in_transit',
  VYSTP: 'in_transit',
  VYSVR: 'in_transit',
  VYZCP: 'in_transit',
  DOP: 'in_transit',
  'P-DOP': 'in_transit',
  'U-DOP': 'in_transit',
  // Ready for another delivery attempt, not out yet.
  OPD: 'in_transit',
  OPDOU: 'in_transit',
  OPN: 'in_transit',
  // Not delivered to the door; the item will be stored at an office or box.
  'B-NEH': 'in_transit',
  'B-NMZB': 'in_transit',
  'B-TDA': 'in_transit',
  'P-NEH': 'in_transit',
  'P-NMZB': 'in_transit',
  'P-TDA': 'in_transit',
  'U-NEH': 'in_transit',
  'U-NMZB': 'in_transit',
  'U-TDA': 'in_transit',
  'U-UANT': 'in_transit',
  'U-NAT': 'in_transit',
  'U-NZS': 'in_transit',
  'U-NZST': 'in_transit',
  'V-NOL': 'in_transit',
  ZNP8: 'in_transit',
  ZNP10: 'in_transit',
  NACOL: 'customs',
  VDOOK: 'out_for_delivery',
  OPDK: 'out_for_delivery',
  VDOVR: 'out_for_delivery',
  // The addressee was not reached.
  ANZ: 'failed_attempt',
  'B-ANZ': 'failed_attempt',
  'B-NOO': 'failed_attempt',
  'B-NZS': 'failed_attempt',
  'P-ANZ': 'failed_attempt',
  'P-ANZT': 'failed_attempt',
  'P-NOO': 'failed_attempt',
  'P-NOOT': 'failed_attempt',
  'P-NZS': 'failed_attempt',
  'P-NZST': 'failed_attempt',
  'U-ANZ': 'failed_attempt',
  'U-ANZP': 'failed_attempt',
  'U-ANZT': 'failed_attempt',
  'U-NOO': 'failed_attempt',
  'U-NOOT': 'failed_attempt',
  // Stored at a post office, a partner's counter, a regional hub, a PoštaPOINT,
  // a BalíkoBOX, an Out BOX or a P.O. box, for the addressee to collect.
  ZNP: 'ready_for_pickup',
  ZNP1: 'ready_for_pickup',
  ZNP1AN: 'ready_for_pickup',
  ZNP1MR: 'ready_for_pickup',
  ZNP1NM: 'ready_for_pickup',
  ZNP1VR: 'ready_for_pickup',
  ZNP2: 'ready_for_pickup',
  ZNP2AN: 'ready_for_pickup',
  ZNP2MR: 'ready_for_pickup',
  ZNP2NM: 'ready_for_pickup',
  ZNP2VR: 'ready_for_pickup',
  ZNP3: 'ready_for_pickup',
  ZNP4: 'ready_for_pickup',
  ZNP5: 'ready_for_pickup',
  ZNP6: 'ready_for_pickup',
  ZNP7: 'ready_for_pickup',
  ZNP8ZP: 'ready_for_pickup',
  ZNP10P: 'ready_for_pickup',
  ZNP11: 'ready_for_pickup',
  ZNP12: 'ready_for_pickup',
  ZNPP: 'ready_for_pickup',
  ZNU: 'ready_for_pickup',
  ZNUA: 'ready_for_pickup',
  ZNUP: 'ready_for_pickup',
  ZNXP: 'ready_for_pickup',
  ZNBB: 'ready_for_pickup',
  ZPT: 'ready_for_pickup',
  ZNK: 'ready_for_pickup',
  BOX: 'ready_for_pickup',
  OBOX: 'ready_for_pickup',
  OK: 'delivered',
  OKB: 'delivered',
  OKP: 'delivered',
  OKPPIN: 'delivered',
  ZVRA: 'returned',
  ZVRAC: 'returned',
  // Addressee unknown, refused, damaged, data to check, force majeure,
  // undeliverable, lost, destroyed, cancelled, refused by customs, or sent back.
  ANZN: 'exception',
  'P-MRT': 'exception',
  'P-NA': 'exception',
  'P-UAN': 'exception',
  'U-UAN': 'exception',
  'U-NA': 'exception',
  AOP: 'exception',
  AOPP: 'exception',
  'P-AOP': 'exception',
  'U-AOP': 'exception',
  'U-OPP': 'exception',
  'P-PZO': 'exception',
  'U-PZO': 'exception',
  ZNP9: 'exception',
  NUZ: 'exception',
  'U-NUZ': 'exception',
  'B-VM': 'exception',
  'P-VM': 'exception',
  'P-VMT': 'exception',
  'U-VM': 'exception',
  'U-VMT': 'exception',
  POUTT: 'exception',
  ZSTR: 'exception',
  ZZNC: 'exception',
  VYMAZ: 'exception',
  ODCOL: 'exception',
  STDOD: 'exception',
  STPOD: 'exception',
  'P-OD': 'exception',
  'P-ANZ2': 'exception',
  'P-NOL': 'exception',
  'P-VRZP': 'exception',
};

/** Events that send the item back, or carry it on the way back: a delivery after one reaches the sender. */
export const RETURN_STARTS: ReadonlySet<string> = new Set(['STDOD', 'STPOD', 'P-OD', 'P-ANZ2', 'P-NOL', 'P-VRZP', 'VDOVR', 'VYSVR']);

// UPU events by their letters.
const UPU: Readonly<Record<string, Stage>> = {
  EMA: 'accepted',
  EMB: 'in_transit',
  EMC: 'in_transit',
  EMD: 'in_transit',
  EMF: 'in_transit',
  EMG: 'in_transit',
  EMJ: 'in_transit',
  EMK: 'in_transit',
  EDC: 'in_transit',
  EDD: 'in_transit',
  EDE: 'in_transit',
  EXC: 'in_transit',
  EME: 'customs',
  EDB: 'customs',
  EXA: 'customs',
  EXB: 'customs',
  EDG: 'out_for_delivery',
  EMH: 'failed_attempt',
  EDH: 'ready_for_pickup',
  EMI: 'delivered',
  EDX: 'exception',
  EXX: 'exception',
};
const UPU_EVENT = /^IPS_(E[A-Z]{2})(?:_([A-Z0-9]{1,8}))?$/;

// Requests and bookkeeping: no movement, so the item keeps its stage.
const NOTICES = new Map<string, string>([
  ['ZDD', 'The delivery day was changed on request.'],
  ['POD', 'The collection period was extended at the addressee\'s request.'],
]);

// Codes whose meaning for the delivery is unclear, left without a stage.
const UNSTAGED = new Map<string, string>([
  ['REKL', 'A complaint about the item is being handled; the code does not say where the item is.'],
  ['B-NOL', 'Not collected from a BalíkoBOX in time; the code does not say whether the item goes on to a post office or back.'],
  ['BBOX_STOCK_REJECTED_FULL', 'The chosen pickup point could not take the item; the code does not say where it goes.'],
  ['ZPZB', 'Taken out of a BalíkoBOX, by a courier or the addressee; the code does not say which.'],
  ['ZVDB', 'Put into a BalíkoBOX, by the sender or for the addressee; the code does not say which.'],
  ['P-NPD', 'Not taken out for delivery, for a reason the code does not give.'],
  ['P-NPDT', 'Not taken out for delivery, for a reason the code does not give.'],
  ['U-NPD', 'Not taken out for delivery, for a reason the code does not give.'],
  ['U-NPDT', 'Not taken out for delivery, for a reason the code does not give.'],
  ['IPS_EDA', 'Held at the inward office of exchange, for customs or for another reason the event does not give.'],
  ['IPS_EDF', 'Held at the delivery office, for a reason the event does not give.'],
  ['IPS_EXD', 'Held at the outward office of exchange, for a reason the event does not give.'],
]);

/** Whether an event is on the item's way back to its sender. */
export function isReturnEvent(code: string): boolean {
  return RETURN_STARTS.has(code) || UPU_EVENT.exec(code)?.[2] === 'BACK';
}

export function isSlovenskaPostaNotice(code: string): boolean {
  return NOTICES.has(code);
}

/** The stage the code alone gives: a UPU delivery on the way back is the sender's. */
export function slovenskaPostaCodeStage(code: string): Stage | undefined {
  if (Object.hasOwn(CODES, code)) return CODES[code];
  const upu = UPU_EVENT.exec(code);
  if (!upu || UNSTAGED.has(`IPS_${upu[1]}`) || !Object.hasOwn(UPU, upu[1]!)) return undefined;
  const stage = UPU[upu[1]!]!;
  return stage === 'delivered' && upu[2] === 'BACK' ? 'returned' : stage;
}

function unstaged(code: string): boolean {
  const upu = UPU_EVENT.exec(code);
  return UNSTAGED.has(code) || (upu !== null && UNSTAGED.has(`IPS_${upu[1]}`));
}

/**
 * An event's stage from the code map, else from the shared wording rules. A
 * code neither knows stays without a stage, so it remains visible for review.
 */
export function slovenskaPostaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = slovenskaPostaCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (unstaged(code) || isSlovenskaPostaNotice(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// The item's state, which the tracking page headlines.
const STATES: Readonly<Record<string, Stage>> = {
  accepted: 'accepted',
  received: 'accepted',
  transit_there: 'in_transit',
  transit_back: 'in_transit',
  customs: 'customs',
  delivering: 'out_for_delivery',
  retained: 'ready_for_pickup',
  delivered: 'delivered',
  returned: 'returned',
  undeliverable: 'exception',
  canceled: 'exception',
};

export function slovenskaPostaStateStage(state: string): Stage | undefined {
  return Object.hasOwn(STATES, state) ? STATES[state] : undefined;
}

/** Every event carries its code, which alone gives the stage. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? slovenskaPostaCodeStage(code) : undefined),
  gaps: [
    ...[...NOTICES].map(([code, note]) => ({ code, note: `${note} Not a movement: the item keeps the stage it had.` })),
    ...[...UNSTAGED].map(([code, note]) => ({ code, note })),
  ],
};
