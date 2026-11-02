import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * CEVA's event codes, as its tracker lists them under each terminal. Only
 * codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['HAWBCR', 'registered'], // Booking created; the freight is still with the shipper.
  ['PICKUP', 'accepted'],
  ['PKU', 'accepted'], // In transit from the shipper, a step of the tracker's progress bar.
  ['OHO', 'in_transit'], // On hand at the origin terminal.
  ['CHKINT', 'in_transit'], // Checked in at a terminal or a hub.
  ['CHKOUT', 'in_transit'], // Checked out of a terminal or a hub.
  ['ATD', 'in_transit'], // Departed, a step of the tracker's progress bar.
  ['INBOND', 'customs'], // Moving under customs bond to the border.
  ['CUSTSB', 'customs'], // Entry filed with customs.
  ['CUSRAL', 'in_transit'], // Cleared by customs.
  ['OHD', 'in_transit'], // On hand at the destination terminal.
  // Handed to the final-mile crew, which can be days before the delivery run.
  ['CHKOFD', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['POD', 'delivered'],
]);

/**
 * The milestone the tracker files a shipment under, with the labels its own
 * script gives them; it heads the page and drives the progress bar.
 */
const MILESTONES: ReadonlyMap<string, Stage> = new Map([
  ['ATSHIPPER', 'registered'],
  ['BOOKING CREATED', 'registered'],
  ['BOOKING CONFIRMED', 'registered'],
  ['INTRANSITFROMSHIPPER', 'accepted'],
  ['ONHANDATORIGIN', 'in_transit'],
  ['INTRANSIT', 'in_transit'],
  ['ONHANDATDESTINATION', 'in_transit'],
  ['OUTFORDELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['DELIVEREDWITHEXCEPTION', 'delivered'],
  ['CLOSEDWITHEXCEPTION', 'exception'],
]);

// Delivery window offers, confirmations and changes, a failed call to the
// customer, and an estimate: notices that move nothing.
const NOTICE = /^(?:APPOFR|APPSET|CEVRES|CONRES|UNACTC|EDELDT)$/;

/** The stage CEVA's codes give an event code or a milestone. */
export function cevaLogisticsMappedStage(code: string): Stage | undefined {
  const key = code.trim().toUpperCase();
  return CODES.get(key) ?? MILESTONES.get(key);
}

/** The stage a milestone gives, for the shipment's own status. */
export function cevaLogisticsMilestoneStage(milestone: string): Stage | undefined {
  return MILESTONES.get(milestone.trim().toUpperCase());
}

/** An event's stage: its code, else the shared wording rules, else nothing. */
export function cevaLogisticsStage(code: string, wording: string): ClassifiedWording | null {
  const key = code.trim().toUpperCase();
  const mapped = CODES.get(key);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE.test(key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

const WINDOW = 'A delivery window offered to, confirmed with or changed for the customer; the freight moves on whatever it says.';

export const statusMap: CarrierStatusMap = {
  codeKey: (code) => code.trim().toUpperCase(),
  stage: (code) => (code ? cevaLogisticsMappedStage(code) : undefined),
  gaps: [
    { code: 'APPOFR', note: WINDOW },
    { code: 'APPSET', note: WINDOW },
    { code: 'CEVRES', note: WINDOW },
    { code: 'CONRES', note: WINDOW },
    { code: 'UNACTC', note: 'CEVA could not reach the customer to book a delivery window; the freight moves on.' },
    { code: 'EDELDT', note: 'An estimated delivery date, not an event.' },
  ],
};
