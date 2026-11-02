import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as chronopost } from '../chronopost/status.js';
import { statusMap as dpd } from '../dpd/status.js';

const labels: Record<string, ClassifiedStatus> = {
  'SHIPPING INFO SENT TO BRT': { status: 'pending', stage: 'registered' },
  COLLECTED: { status: 'in_transit', stage: 'accepted' },
  DEPARTED: { status: 'in_transit', stage: 'in_transit' },
  'ARRIVED AT DEPOT': { status: 'in_transit', stage: 'in_transit' },
  'FOR DELIVERY': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'ARRIVED AT BRT LOCKER': { status: 'in_transit', stage: 'ready_for_pickup' },
  'COLLECTED AT BRT LOCKER': { status: 'delivered', stage: 'delivered' },
  'ARRIVED AT BRT-FERMOPOINT': { status: 'in_transit', stage: 'ready_for_pickup' },
  'COLLECTED AT BRT-FERMOPOINT': { status: 'delivered', stage: 'delivered' },
  // The partner abroad that delivers the parcel has left it at its parcel shop.
  'TO COLLECT AT THE PARCEL SHOP': { status: 'in_transit', stage: 'ready_for_pickup' },
  'UNKNOWN/INCOMPLETE CONSIGNEE': { status: 'exception', stage: 'failed_attempt' },
  // The courier found no one in and left a notice.
  'NOTICE OF ATTEMPTED DELIVERY': { status: 'exception', stage: 'failed_attempt' },
  // A public demonstration holds the parcel up.
  TURMOIL: { status: 'exception', stage: 'exception' },
  'RETURNED TO SENDER': { status: 'exception', stage: 'returned' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
};

/**
 * The labels BRT's Italian page gives the scans its English page labels so,
 * as both pages show them. The Italian of a locker's scans and of the parcel
 * shop abroad has not been seen.
 */
const ITALIAN: Readonly<Record<string, string>> = {
  'DATI SPEDIZ. TRASMESSI A BRT': 'SHIPPING INFO SENT TO BRT',
  RITIRATA: 'COLLECTED',
  PARTITA: 'DEPARTED',
  'ARRIVATA IN FILIALE': 'ARRIVED AT DEPOT',
  'IN CONSEGNA': 'FOR DELIVERY',
  'ARRIVATA AL BRT-FERMOPOINT': 'ARRIVED AT BRT-FERMOPOINT',
  'RITIRATA AL BRT-FERMOPOINT': 'COLLECTED AT BRT-FERMOPOINT',
  'DESTINATAR.SCONOSC./INCOMPLETO': 'UNKNOWN/INCOMPLETE CONSIGNEE',
  'MANIFESTAZIONE PUBBLICA': 'TURMOIL',
  'RESO MITTENTE': 'RETURNED TO SENDER',
  CONSEGNATA: 'DELIVERED',
  'DESTIN.ASSENTE:LASCIATO AVVISO': 'NOTICE OF ATTEMPTED DELIVERY',
  // The map stages neither label.
  'REINDIRIZZATA A BRT-FERMOPOINT': 'REDIRECT TO BRT-FERMOPOINT',
};

const key = (label: string) => label.replace(/\s+/g, ' ').trim().toUpperCase();

/** The English label of a label BRT's Italian page gives, upper-cased; undefined for any other. */
export function brtEnglishLabel(label: string): string | undefined {
  const italian = key(label);
  return Object.hasOwn(ITALIAN, italian) ? ITALIAN[italian] : undefined;
}

/** A label's reading, in English or Italian. */
export function classifyBrtStatus(label: string): ClassifiedStatus | undefined {
  const english = brtEnglishLabel(label) ?? key(label);
  return Object.hasOwn(labels, english) ? labels[english] : undefined;
}

/** In the DPD leg that brought a parcel to BRT, the scans whose stage the scans before them decide (`stagedDpdLeg`). */
export const DPD_INTAKE: ReadonlySet<string> = new Set(['PARCEL_HANDED', 'ORI']);
export const DPD_TRANSIT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SPL', 'AT_DELIVERY_CENTER']);

const DPD_LEG_TRANSIT = 'In the DPD leg before BRT it moves the parcel only once DPD has taken it in; before that it names no movement of its own.';

/**
 * What the map says about one scan. BRT's own scans carry no code. A scan with a code comes from
 * the leg of the partner that brought the parcel to BRT and reads that partner's map. In DPD's leg
 * the hand-over and the depot's intake always get a stage, which the scans before them decide.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? chronopost.stage(code, wording) ?? dpd.stage(code, wording) : classifyBrtStatus(wording)?.stage),
  gaps: [
    ...chronopost.gaps,
    ...dpd.gaps.flatMap((gap) => (gap.code === undefined || DPD_INTAKE.has(gap.code) ? []
      : [{ ...gap, note: DPD_TRANSIT.has(gap.code) ? DPD_LEG_TRANSIT : gap.note }])),
  ],
};
