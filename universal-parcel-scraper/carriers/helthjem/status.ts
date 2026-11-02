import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Helthjem files a parcel and each of its scans under one of twelve states,
 * the `EventStatusType` of its tracking service, and words them in Norwegian.
 * The labels are the tracking page's own.
 */
const STATES: ReadonlyMap<string, { readonly stage: Stage; readonly label: string }> = new Map([
  // The shop announced the parcel; Helthjem does not have it yet.
  ['REGISTERED', { stage: 'registered', label: 'Pakken er registrert' }],
  ['IN_TRANSIT', { stage: 'in_transit', label: 'På vei til mottaker' }],
  // On the round. A booking on the coming night's round and a night missed
  // are filed here too; their event codes tell them apart.
  ['DELIVERING', { stage: 'out_for_delivery', label: 'Leveres' }],
  ['DELIVERED', { stage: 'delivered', label: 'Levert' }],
  // A home delivery sent on to a pickup point instead.
  ['CONVERTED_TO_STORE', { stage: 'in_transit', label: 'På vei til hentested' }],
  ['DELIVERING_TO_STORE', { stage: 'in_transit', label: 'Leveres til hentested' }],
  ['READY_FOR_PICKUP', { stage: 'ready_for_pickup', label: 'Klar til henting' }],
  // Collected by the recipient at the pickup point.
  ['PICKED_UP', { stage: 'delivered', label: 'Pakken er hentet' }],
  // Not collected in time: it goes back to the shop.
  ['RETURN_TO_STORE', { stage: 'exception', label: 'Pakke ikke hentet' }],
  ['RETURNING', { stage: 'exception', label: 'Returneres' }],
  // The page words it like RETURNING; the state names the parcel as returned.
  ['PARCEL_RETURNED', { stage: 'returned', label: 'Returneres' }],
  ['CANCELED', { stage: 'exception', label: 'Pakken er kansellert' }],
]);

/** Scans whose event code says more than their state. */
const EVENTS: ReadonlyMap<string, Stage> = new Map([
  // "Planlagt levering natt til 24. oktober!": the parcel is booked on the
  // coming night's round, announced the day before. No courier has it yet.
  ['DELIVERING/113', 'in_transit'],
  // "Budet fikk ikke med seg pakken din ut i natt": the night's courier did
  // not take the parcel out, so it waits for a later round.
  ['DELIVERING/057', 'in_transit'],
]);

/** The state is a word of capitals and underscores. */
export const STATE = /^[A-Z][A-Z_]{1,39}$/;

/** The stage of a state, or of a scan by its state and event code. */
export function helthjemStage(state: string, event = ''): Stage | undefined {
  return EVENTS.get(`${state}/${event}`) ?? STATES.get(state)?.stage;
}

/** The tracking page's label for a state, used when a reply has no scan to word it. */
export function helthjemLabel(state: string): string | undefined {
  return STATES.get(state)?.label;
}

/**
 * A scan's provider code is its state, a slash and its three-digit event
 * code: "IN_TRANSIT/003". A scan without a state keeps its event code alone.
 */
export function helthjemCode(state: string, event: string): string {
  return state && event ? `${state}/${event}` : state || event;
}

/** The map reads the state, and the event code where it says more; a code without a state is staged by its wording. */
export const statusMap: CarrierStatusMap = {
  codeKey: (code) => code.split('/')[0] ?? code,
  stage: (code) => {
    const [state, event] = code?.split('/') ?? [];
    return state && STATE.test(state) ? helthjemStage(state, event) : undefined;
  },
  gaps: [],
};
