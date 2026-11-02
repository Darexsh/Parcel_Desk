import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One kind of row on A1 POST's tracker: its wording, then the place the row names, if any. */
interface A1PostRow {
  readonly pattern: RegExp;
  readonly stage: Stage;
  /** A1 POST's own row or a scan in Bulgaria, whose clock is Sofia's. */
  readonly home: boolean;
}

/**
 * The rows seen on A1 POST's tracker, in English and in Bulgarian. A1 POST's
 * own rows say the sender's data arrived and that A1 POST processed the
 * parcel. Older pages also listed the Bulgarian office scans on the way to A1
 * POST, each followed by the office, and its USPS partner's scans, each
 * followed by a US place. Only wordings seen in replies are mapped.
 */
const ROWS: readonly A1PostRow[] = [
  { pattern: /^(Shipment information uploaded to A1 POST)$/iu, stage: 'registered', home: true },
  { pattern: /^(Информацията за пратката е качена в A1 POST)$/iu, stage: 'registered', home: true },
  { pattern: /^(The shipment has been processed,? A1 POST)$/iu, stage: 'in_transit', home: true },
  { pattern: /^(Пратката е обработена,? A1 POST)$/iu, stage: 'in_transit', home: true },
  { pattern: /^(Arrive in office)(?: (.+))?$/iu, stage: 'in_transit', home: true },
  { pattern: /^(Loaded to line-haul)(?: (.+))?$/iu, stage: 'in_transit', home: true },
  { pattern: /^(Received by employee)(?: (.+))?$/iu, stage: 'in_transit', home: true },
  // The USPS label exists; USPS does not have the parcel yet.
  { pattern: /^(Shipping Label Created, USPS Awaiting Item)(?: (.+))?$/iu, stage: 'registered', home: false },
  { pattern: /^(Departed Shipping Partner Facility, USPS Awaiting Item)(?: in (.+))?$/iu, stage: 'in_transit', home: false },
];

/** A row's text split into its wording and place, with the stage and clock the map gives it. */
export interface A1PostScan {
  readonly wording: string;
  readonly place: string;
  readonly stage?: ClassifiedWording;
  readonly home: boolean;
}

/**
 * A row's wording, place and stage. A row the map does not know keeps its
 * whole text, which the shared wording rules may stage, and its clock is not
 * known to be Sofia's.
 */
export function a1PostScan(text: string): A1PostScan {
  for (const row of ROWS) {
    const match = row.pattern.exec(text);
    if (match) return { wording: match[1]!, place: match[2] ?? '', stage: { stage: row.stage, source: 'carrier_map' }, home: row.home };
  }
  const worded = classifyWording(text, 'in_transit');
  return { wording: text, place: '', ...(worded.source === 'none' ? {} : { stage: worded }), home: false };
}

/** The stage A1 POST's map gives a row's wording, with or without its place. */
export function a1PostStage(wording: string): Stage | undefined {
  return ROWS.find((row) => row.pattern.test(wording))?.stage;
}

/** Rows come without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? a1PostStage(wording) : undefined),
  gaps: [],
};
