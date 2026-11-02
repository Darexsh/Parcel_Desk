/**
 * Correos (Spain) status vocabulary.
 *
 * `codEvento` is the stable key of a localizador event; the
 * `desTextoResumen` next to it is display prose and is never mapped. The
 * vocabulary is explicitly still being observed, so an unmapped code yields no
 * stage at all: the event keeps its raw wording, the result reports `unknown`,
 * and the sync classifies and records it.
 *
 * Provenance: derived from the prior-art client
 * https://github.com/ha-parcel-integrations/ha-correos (MIT) and confirmed
 * against a real ES parcel on 2026-08-24 (admitted → classified →
 * out for delivery → failed attempt → office hold → collected).
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const EVENT_STATUS: Record<string, ClassifiedStatus> = {
  // Prerregistrado: the sender registered the parcel. Admitido: Correos took it in.
  'A090000V': { status: 'pending', stage: 'registered' },
  'X010000V': { status: 'pending', stage: 'registered' },
  'A010000V': { status: 'in_transit', stage: 'accepted' },
  'A010AA0V': { status: 'in_transit', stage: 'accepted' },
  'P040000V': { status: 'in_transit', stage: 'in_transit' },
  'P100000V': { status: 'in_transit', stage: 'in_transit' },
  'P110000V': { status: 'in_transit', stage: 'in_transit' },
  'P101110V': { status: 'in_transit', stage: 'in_transit' },
  'P101120V': { status: 'in_transit', stage: 'in_transit' },
  'P090000V': { status: 'in_transit', stage: 'in_transit' },
  'G01L010V': { status: 'in_transit', stage: 'in_transit' },
  'H01I360V': { status: 'in_transit', stage: 'in_transit' },
  'X020000V': { status: 'in_transit', stage: 'in_transit' },
  'X040000V': { status: 'in_transit', stage: 'in_transit' },
  'X060000V': { status: 'in_transit', stage: 'in_transit' },
  'X070000V': { status: 'in_transit', stage: 'in_transit' },
  'X110100V': { status: 'in_transit', stage: 'in_transit' },
  'H020000V': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'X080000V': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'H01I350V': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'X380000V': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'X390000V': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  // Community-integration reconstructions, not yet re-observed: kept, but an
  // unmapped code elsewhere still reports unknown rather than guessing.
  'L010000V': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'I01H210V': { status: 'delivered', stage: 'delivered' },
  'X120000V': { status: 'delivered', stage: 'delivered' },
  'I010000V': { status: 'delivered', stage: 'delivered' },
  'H010930R': { status: 'exception', stage: 'failed_attempt' },
  'H06P010V': { status: 'exception', stage: 'failed_attempt' },
  'X090100R': { status: 'exception', stage: 'failed_attempt' },
  'X090060R': { status: 'exception', stage: 'failed_attempt' },
  'X130000R': { status: 'exception', stage: 'failed_attempt' },
  'M01E020R': { status: 'exception', stage: 'failed_attempt' },
  'EOL.9001': { status: 'exception', stage: 'failed_attempt' },
  'O140000V': { status: 'exception', stage: 'returned' },
  // Observed live on public parcels in the number corpus.
  'B030000V': { status: 'in_transit', stage: 'in_transit' },
  'C010000V': { status: 'in_transit', stage: 'in_transit' },
  'D050000V': { status: 'in_transit', stage: 'in_transit' },
  'F010000V': { status: 'in_transit', stage: 'in_transit' },
  'G200000V': { status: 'in_transit', stage: 'in_transit' },
  'H250000V': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'ADV0000V': { status: 'in_transit', stage: 'accepted' },
  'H01R390V': { status: 'exception', stage: 'failed_attempt' },
  'H01R420V': { status: 'exception', stage: 'failed_attempt' },
  // Recorded straight after the parcel went out for delivery.
  'H01R424V': { status: 'exception', stage: 'failed_attempt' },
  // Held at the office for the recipient to collect: observed live.
  'G01L020V': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  // The pickup window closed: the parcel goes back to the sender.
  'L03D320R': { status: 'exception', stage: 'returned' },
  // The sender left the parcel in a Citypaq locker; Correos admits it later.
  'A170000V': { status: 'pending', stage: 'registered' },
  // Collected from the address a pickup request gave, before admission.
  'HI10002V': { status: 'in_transit', stage: 'accepted' },
  // Observed live on public certified letters in the number corpus.
  'E000001V': { status: 'in_transit', stage: 'customs' },
  'E040990V': { status: 'in_transit', stage: 'customs' },
  // In the origin country's customs; then the processing completed, which puts the parcel back in transit.
  'B170000V': { status: 'in_transit', stage: 'customs' },
  'E510000V': { status: 'in_transit', stage: 'in_transit' },
  // An import under customs transit: procedures started, transit authorised, transit cleared, all
  // in customs; then the procedures finished, which puts the parcel back in transit.
  'E819300V': { status: 'in_transit', stage: 'customs' },
  'E508700V': { status: 'in_transit', stage: 'customs' },
  'E134630V': { status: 'in_transit', stage: 'customs' },
  'E190000V': { status: 'in_transit', stage: 'in_transit' },
  // Handed back to the sender, or on the way back: never a delivery to the recipient.
  'I020000V': { status: 'exception', stage: 'returned' },
  'I01H230V': { status: 'exception', stage: 'returned' },
  'O130000V': { status: 'exception', stage: 'returned' },
  'L031070R': { status: 'exception', stage: 'returned' },
  'L03D240R': { status: 'exception', stage: 'returned' },
};

// Codes the English reply leaves without a summary, worded from the Spanish one.
const ENGLISH_SUMMARY: Readonly<Record<string, string>> = {
  'HI10002V': 'Shipment collected',
};

/** The English summary of a code the localizador gives none in English. */
export function correosSpainEnglishSummary(code: string): string {
  return ENGLISH_SUMMARY[code] ?? '';
}

/** The stage and status for a Correos `codEvento`, or undefined when unmapped. */
export function classifyCorreosSpainStatus(code: string): ClassifiedStatus | undefined {
  return EVENT_STATUS[code];
}

/**
 * The scans the review queue holds without their code, from before events
 * kept it, by `normalizeStatusWording` wording. Each is the summary Correos
 * gives that code.
 */
const UNCODED_SCANS: ReadonlyMap<string, string> = new Map([
  ['a disposición del destinatario', 'G01L020V'],
]);

/**
 * Scans in no stage of their own, which keep the stage of the scan before them.
 * H01C120V is worded "In delivery" like the delivery round, but comes while the
 * parcel waits at the destination's post office for collection; Correos' code
 * list calls the H01 codes "En curso".
 */
export const NOTICE_CODES: ReadonlySet<string> = new Set(['H01C120V']);

/** What the map says about one scan, by its `codEvento`. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const key = code ? code.toLocaleUpperCase('en-US') : UNCODED_SCANS.get(wording);
    return key ? classifyCorreosSpainStatus(key)?.stage : undefined;
  },
  gaps: [
    { code: 'H01C120V', note: 'Worded like the delivery round, but seen while the parcel waits at a post office for collection: the parcel keeps the stage it had.' },
  ],
};
