import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * BEX Express's scans carry a status code and the code of the barcode scan
 * that set it. A scan's provider code is its status, then its scan after a
 * colon when the scan is not 0, as "11:3".
 */
export function bexCode(status: number, scan: number): string {
  return scan ? `${status}:${scan}` : String(status);
}

/** The labels the tracking page's script gives a status and scan code. */
const SCAN_LABELS: ReadonlyMap<string, string> = new Map([
  ['-51:103', 'Evidentirano - Stiglo na carinu'],
  ['-51:104', 'Evidentirano - U procesu carinjenja'],
  ['-51:105', 'Evidentirano - Ocarinjeno'],
  ['1:51', 'Evidentirano - Predato Bex-u sa carine'],
  ['1:105', 'Evidentirano - Ocarinjeno'],
  ['11:3', 'Preuzeto - Kod kurira na dostavi'],
  ['11:4', 'Preuzeto - Kurir vratio Pošiljku u centar dostave'],
  ['11:8', 'Preuzeto - Pošiljka je u tranzitu do centra dostave'],
  ['11:10', 'Preuzeto - Pošiljka u centru dostave'],
  ['11:11', 'Preuzeto - Tranzitira ka centru dostave'],
  ['11:15', 'Preuzeto - Pošiljka u centru dostave'],
  ['11:40', 'Preuzeto'],
  ['11:46', 'Preuzeto - Pošiljka u Paket Šopu'],
  ['11:51', 'Preuzeto - Pošiljka preuzeta iz carine i Bex-u'],
  ['11:100', 'Preuzeto - Neuspela dostava'],
  ['11:101', 'Reklamacija - Izgubljena pošiljka'],
  ['21:109', 'Otkup za isplatu'],
  ['21:110', 'Otkup isplaćen'],
]);

/** The page's label for any other scan of a status it names. */
const STATUS_LABELS: ReadonlyMap<number, string> = new Map([
  [-51, 'Evidentirano – Ino tranzit'],
  [-21, 'Evidentirano - na proveri podataka'],
  [1, 'Evidentirano'],
  [11, 'Preuzeto'],
  [21, 'Dostavljena pošiljka'],
  [25, 'Vratiti pošiljaocu'],
  [30, 'Vraćena pošiljka'],
  [31, 'Isplaćena otkupnina'],
]);

/** The page's label for a status it names by its `statusName` only. */
const NAME_LABELS: ReadonlyMap<string, string> = new Map([
  ['Stornirana', 'Otkazano'],
  ['Carina', 'Evidentirano - na carini'],
  ['Za PP', 'Evidentirano - na proveri podataka'],
  ['Evidentirano', 'Evidentirano'],
  ['Preuzeto', 'Preuzeto od pošiljaoca'],
  ['Dostavljeno', 'Dostavljeno primaocu'],
]);

/**
 * A scan's wording, as the tracking page labels its status and scan code; a
 * status the page does not name keeps the reply's `statusName`.
 */
export function bexLabel(status: number, scan: number, name: string): string {
  return SCAN_LABELS.get(bexCode(status, scan)) ?? STATUS_LABELS.get(status) ?? NAME_LABELS.get(name) ?? name;
}

/** The status and scan codes whose meaning the page's labels and the API documentation give. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['-51', 'in_transit'], // Registered while in international transit.
  ['-51:103', 'customs'], // Arrived at customs.
  ['-51:104', 'customs'], // In customs clearance.
  ['-51:105', 'in_transit'], // Cleared customs.
  ['1', 'registered'], // Entered into the system.
  ['1:51', 'in_transit'], // Handed to BEX by customs.
  ['1:105', 'in_transit'], // Cleared customs.
  ['11', 'accepted'], // Collected from the sender.
  ['11:40', 'accepted'],
  ['11:3', 'out_for_delivery'], // With the courier for delivery.
  ['11:4', 'failed_attempt'], // The courier brought it back to the delivery centre.
  ['11:8', 'in_transit'],
  ['11:10', 'in_transit'], // At the delivery centre.
  ['11:11', 'in_transit'],
  ['11:15', 'in_transit'], // At the delivery centre.
  ['11:46', 'ready_for_pickup'], // Waiting in a Paket Shop.
  ['11:51', 'in_transit'], // Taken from customs to BEX.
  ['11:100', 'failed_attempt'],
  ['11:101', 'exception'], // A claim for a lost parcel.
]);

/** Statuses whose every scan means the same. */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['-21', 'exception'], // Held while the operator checks the address.
  ['0', 'exception'], // Cancelled.
  ['21', 'delivered'],
  ['25', 'returned'], // To be returned to the sender.
  ['30', 'returned'], // Returned to the sender.
]);

// The cash on delivery waiting for or paid to the sender, after the delivery: it moves nothing.
const NOTICE = /^(?:21:(?:109|110)|31(?::\d+)?)$/;
// The statuses the page names; a scan of one of them that the map does not know has no stage.
const NAMED = /^(?:-51|-21|0|1|11|21|25|30|31)(?::|$)/;

/** The stage BEX Express's codes give a scan's provider code. */
export function bexMappedStage(code: string): Stage | undefined {
  if (NOTICE.test(code)) return undefined;
  return CODES.get(code) ?? STATUSES.get(code.split(':')[0]!);
}

/**
 * A scan's stage: its codes, else nothing for a scan of a status the page
 * names, else the shared wording rules.
 */
export function bexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = bexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NAMED.test(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

const PAYOUT = 'The cash on delivery waiting for or paid out to the sender, after the delivery; it moves nothing.';

export const statusMap: CarrierStatusMap = {
  // Every scan of status 31 is the payout.
  codeKey: (code) => (/^31:/.test(code) ? '31' : code),
  stage: (code) => (code ? bexMappedStage(code) : undefined),
  gaps: [
    { code: '21:109', note: PAYOUT },
    { code: '21:110', note: PAYOUT },
    { code: '31', note: PAYOUT },
  ],
};
