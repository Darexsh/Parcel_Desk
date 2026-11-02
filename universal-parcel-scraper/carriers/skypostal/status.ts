import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SkyPostal's event codes (`track_cdg`), which its tracker shows beside each
 * scan's wording. They cover its own Miami leg and the destination partner's
 * scans it relays. Only codes seen in replies are mapped; another code falls
 * to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DRC', 'registered'], // DATA RECEIVED: the shipment's data, before the parcel.
  ['HCV', 'registered'], // HS_CODE VALIDATION: tariff codes checked before the parcel arrives.
  ['TIC', 'registered'], // TAX ID COLLECTED: the buyer's tax ID for import.
  ['DCO', 'registered'], // DOCUMENTATION COMPLETE.
  ['RUT', 'accepted'], // RECEPTACLE RECEIVED IN US TRANSPORT FACILITY: the bag holding the parcel reached the Miami hub.
  ['REC', 'accepted'], // RECEIVED at the Miami hub.
  ['XRS', 'in_transit'], // X-RAY SCAN at the hub.
  ['PLP', 'in_transit'], // PROVIDER LABEL PRINTED: the destination partner's label, printed at the hub.
  ['INC', 'in_transit'], // NESTED TO RECEPTACLE: bagged for export.
  ['PRO', 'in_transit'], // PROCESSED.
  ['MNF', 'in_transit'], // SHIPPED: manifested for export.
  ['FDP', 'in_transit'], // FLIGHT DEPARTED.
  ['ATT', 'in_transit'], // ARRIVED IN TRANSIT COUNTRY: a stop between flights.
  ['ATC', 'in_transit'], // ARRIVED IN COUNTRY.
  // DELIVERED FROM AIRLINE TO OPERATOR: handed to the ground operator at the
  // destination airport, which the wording rules would read as a delivery.
  ['DTP', 'in_transit'],
  ['CEN', 'customs'], // CUSTOMS ENTRY.
  ['CHE', 'customs'], // CUSTOMS HOLD AT CONTROL ENTITY: waiting for the airport's bonded warehouse to release it.
  ['HTI', 'exception'], // HOLD FOR PROBLEMATIC TAX ID: customs wait for the buyer to correct their tax ID.
  ['CCH', 'in_transit'], // CUSTOMS CLEARED.
  ['TTC', 'in_transit'], // TENDERED TO LOCAL CARRIER: handed to the destination partner.
  ['TDP', 'in_transit'], // TRANSFERRED TO THIRD PARTY DELIVERY PARTNER: the destination partner hands it on.
  ['PES', 'in_transit'], // PROVIDER ENTRY SCAN: the destination partner's first scan.
  ['INT', 'in_transit'], // IN TRANSIT.
  ['PRH', 'in_transit'], // PACKAGE RECEIVED AT TRANSFER HUB, which the wording rules would read as acceptance.
  ['PDH', 'in_transit'], // PACKAGE DEPARTED TRANSFER HUB.
  ['OFD', 'out_for_delivery'],
  ['CNA', 'failed_attempt'], // CONSIGNEE NOT AVAILABLE.
  ['PIK', 'ready_for_pickup'], // AVAILABLE FOR PICKUP.
  ['DRF', 'exception'], // DELIVERY REFUSED BY ADDRESSEE.
  ['ICA', 'exception'], // INCORRECT / INCOMPLETE ADDRESS: waits for the sender to act.
  ['DEL', 'delivered'],
  ['PLR', 'exception'], // PROVIDER LABEL REJECTED: the partner's label was refused and the parcel held.
  ['INH', 'exception'], // ON HOLD.
  ['SLH', 'in_transit'], // HOLD RESOLVED: the parcel moves on.
]);

// Billing steps at the hub (CUT, PAY) and the fuel surcharge (FSC) move nothing.
const BILLING = new Set(['CUT', 'PAY', 'FSC']);

/** The stage SkyPostal's codes give a scan code. */
export function skypostalMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function skypostalStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = skypostalMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (BILLING.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? skypostalMappedStage(code) : undefined),
  gaps: [
    { code: 'CUT', note: 'A billing step at the Miami hub; it moves nothing.' },
    { code: 'PAY', note: 'A billing step at the Miami hub; it moves nothing.' },
    { code: 'FSC', note: 'A fuel surcharge recorded against the shipment; it moves nothing.' },
    { code: 'OTH', note: 'A catch-all code, seen as the release from a hold; the scans around it give the stage.' },
  ],
};
