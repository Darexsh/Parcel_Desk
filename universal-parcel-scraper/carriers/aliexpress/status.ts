/**
 * Cainiao status vocabulary.
 *
 * Two vocabularies arrive in the same payload and they are not equivalent:
 *
 * - `latestTrace.actionCode` (and `detailList[].actionCode`) is the leg-level
 *   scan code. It is the primary signal, mapped by `ACTION_STATUS` below.
 * - The parcel-level `status` token is a coarse order state. Its vocabulary is
 *   unestablished (real parcels carry values such as DELIVERED, CLEAR_CUSTOMS,
 *   transport, pickup, delivered), so it is only consulted when no action code
 *   is present.
 *
 * Provenance: the action map follows the prior-art client
 * https://github.com/ha-parcel-integrations/ha-cainiao (`parcels.py`
 * `_ACTION_MAP`, 41 codes grouped by leg, MIT).
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Parcel-level order tokens, used only when the newest trace has no action code. */
export const CAINIAO_STATUS = new Map<string, CarrierStatus>([
  ['WAIT_SELLER_SEND_GOODS', 'pending'],
  ['SELLER_SEND_GOODS', 'pending'],
  ['SELLER_PREPARING', 'pending'],
  ['WAIT_BUYER_ACCEPT_GOODS', 'in_transit'],
  ['DELIVERING', 'in_transit'],
  ['SIGN', 'delivered'],
  ['FAILED', 'exception'],
  ['RETURNED', 'exception'],
]);

// Primary signal, from ha-cainiao parcels.py _ACTION_MAP (41 codes, grouped by
// leg). The parcel-level `status` token vocabulary is unestablished (real
// parcels carry DELIVERED/CLEAR_CUSTOMS/transport/pickup/delivered), so the
// newest latestTrace.actionCode wins and the token is only a fallback.
// LH_HO_OUT_SUCCESS, TD_TRANSWH_OUTBOUND, TD_TRANS_ARRIVE_DCP and
// GTMS_SC_DEPART were seen live on 2026-10-08, between the linehaul's arrival
// and the local partner's round, each worded as one more leg of the journey.
// statuses.json records every code Cainiao's own replies have shown.
export const CAINIAO_ACTION_STATUS = new Map<string, CarrierStatus>([
  ['GWMS_ACCEPT', 'pending'],
  // "Order Created": the last-mile gateway's order for the parcel, before anyone has it.
  ['CREATE_ORDER_CES', 'pending'],
  ['GWMS_PACKAGE', 'pending'],
  ['PRE_READY_TO_SHIP', 'pending'],
  ['CONSIGN', 'pending'],
  // Cainiao Express's steps for a partner's parcel before Cainiao Express has
  // it: the shipment's data, then its way from the partner's facility.
  ['LABEL_CREATED', 'pending'],
  ['PARTNER_OUTBOUND_FR', 'in_transit'],
  ['IN_TRANSIT_FR', 'in_transit'],
  ['CW_INBOUND', 'in_transit'],
  // "Arrived at warehouse": the consolidation warehouse signs the parcel in, before its "Departed from warehouse".
  ['CW_SIGN_IN_SUCCESS', 'in_transit'],
  ['CW_OUTBOUND', 'in_transit'],
  ['CW_COMMON_PROCESSING1', 'in_transit'],
  ['PU_PICKUP_SUCCESS', 'in_transit'],
  ['GWMS_OUTBOUND', 'in_transit'],
  ['SC_INBOUND_SUCCESS', 'in_transit'],
  ['SC_OUTBOUND_SUCCESS', 'in_transit'],
  ['SC_TRANS_INBOUND_SUCCESS', 'in_transit'],
  ['SC_TRANS_OUTBOUND_SUCCESS', 'in_transit'],
  ['SC_HO_OUT_SUCCESS', 'in_transit'],
  ['SC_INBOUND', 'in_transit'],
  // "Package not accepted by sorting center": the sorting center turned the parcel away.
  ['SC_INBOUND_FAILURE', 'exception'],
  ['SC_SORTING', 'in_transit'],
  ['SC_OUTBOUND', 'in_transit'],
  // "Processing delay at sorting center": a delay before the parcel leaves, not a fault.
  ['SC_OUTBOUND_FAILURE', 'in_transit'],
  ['TRANSFER_DEPART', 'in_transit'],
  ['TRANSFER_ARRIVE', 'in_transit'],
  ['CC_EX_START', 'in_transit'],
  ['CC_EX_SUCCESS', 'in_transit'],
  ['LH_HO_IN_SUCCESS', 'in_transit'],
  ['LH_HO_AIRLINE', 'in_transit'],
  ['LH_DEPART', 'in_transit'],
  ['LH_ARRIVE', 'in_transit'],
  ['LH_HO_OUT_SUCCESS', 'in_transit'],
  ['LH_POST_COLLECTION', 'in_transit'],
  ['LH_TRANS_ARRIVE', 'in_transit'],
  ['LH_TRANS_DEPART', 'in_transit'],
  ['COMMON_INTRANSIT', 'in_transit'],
  ['TD_TRANS_DEPART', 'in_transit'],
  ['TD_TRANS_ARRIVE', 'in_transit'],
  ['TD_TRANS_DEPART_C', 'in_transit'],
  ['TD_TRANS_ARRIVE_C', 'in_transit'],
  ['TD_TRANSWH_OUTBOUND', 'in_transit'],
  ['TD_TRANS_ARRIVE_DCP', 'in_transit'],
  ['CC_HO_IN_SUCCESS', 'in_transit'],
  ['CC_IM_START', 'in_transit'],
  ['CC_IM_SUCCESS', 'in_transit'],
  ['CC_HO_OUT_SUCCESS', 'in_transit'],
  ['CC_IM_FAILURE', 'exception'],
  ['CC_IM_EXCEPTION', 'exception'],
  ['GTMS_ACCEPT', 'in_transit'],
  // The partner relabelling the parcel with its own number at its facility.
  ['GTMS_RELABEL', 'in_transit'],
  // A partner accepting the parcel after the hand-off: Cainiao accepted it long before.
  ['SL_ACCEPT', 'in_transit'],
  // "Shipment departed from facility": the hand-over to the courier that delivers the parcel, before its round.
  ['LAST_MILE_HO_SUCCESS', 'in_transit'],
  ['GTMS_SC_ARRIVE', 'in_transit'],
  ['GTMS_DO_ARRIVE', 'in_transit'],
  ['GTMS_STATION_OUT', 'in_transit'],
  ['GTMS_SC_DEPART', 'in_transit'],
  ['SC_ARRIVE', 'in_transit'],
  ['SC_DEPART', 'in_transit'],
  ['OE_DEPART', 'in_transit'],
  ['GTMS_DO_DEPART', 'out_for_delivery'],
  ['LM_DELIVERY_DEPART', 'out_for_delivery'],
  ['GSTA_INBOUND', 'out_for_delivery'],
  ['GSTA_INFORM_BUYER', 'out_for_delivery'],
  ['GTMS_WAIT_SELF_PICK', 'out_for_delivery'],
  // Station signed, not the recipient — must never read as delivered.
  ['GTMS_STA_SIGNED', 'out_for_delivery'],
  // "Delivered to PUDO": the pickup point took the parcel in, so it waits there, not delivered.
  ['PUDO_DELIVERY', 'out_for_delivery'],
  ['GTMS_SIGNED', 'delivered'],
  ['LM_SIGN_SUCCESS', 'delivered'],
  // The recipient collected the parcel from the pickup point.
  ['GSTA_SIGN', 'delivered'],
  // The courier could not deliver and tries again: a failed attempt, below.
  ['GTMS_DEL_FAILURE', 'exception'],
  // "Delivered to PUDO Failure": the courier could not leave it at the pickup point (closed): a failed attempt, below.
  ['PUDO_DELIVERY_FAILURE', 'exception'],
  // "Delivery Failed": the last-mile gateway's failed round, with the reason in its longer wording: a failed attempt, below.
  ['LM_DELIVERY_FAILURE', 'exception'],
  // The delivery closed as failed after its attempts.
  ['GTMS_SIGN_FAILURE', 'exception'],
  ['GTMS_STA_SIGN_FAILURE', 'exception'],
  // Back at the local warehouse after the failed delivery, on its way back.
  ['RT_INBOUND', 'exception'],
  ['EXCEPTION', 'exception'],
]);

/** Out-for-delivery actions that mean "waiting at a pickup point", not "on the van". */
export const CAINIAO_PICKUP_ACTIONS = new Set(['GSTA_INBOUND', 'GSTA_INFORM_BUYER', 'GTMS_WAIT_SELF_PICK', 'GTMS_STA_SIGNED', 'PUDO_DELIVERY']);

/** Normalize an action code: Cainiao has been seen spelling them with spaces and in lower case. */
export function cainiaoActionCode(value: unknown): string {
  return (typeof value === 'string' ? value : '').trim().toLocaleUpperCase('en-US').replace(/\s+/g, '_');
}

/** Coarse status fallback when Cainiao supplies no action code. */
export function cainiaoStageByStatus(): Partial<Record<CarrierStatus, Stage>> {
  return {
    pending: 'registered',
    in_transit: 'in_transit',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    exception: 'exception',
  };
}

/** Each scan keeps its own milestone even after the parcel progresses. */
export function cainiaoActionStage(code: string): Stage | undefined {
  if (CAINIAO_PICKUP_ACTIONS.has(code)) return 'ready_for_pickup';
  if (['CC_EX_START', 'CC_IM_START', 'CC_HO_IN_SUCCESS'].includes(code)) return 'customs';
  if (code === 'PU_PICKUP_SUCCESS') return 'accepted';
  // Cainiao's last-mile gateway words it "Delivery Attempt Failure" in its
  // `delivery_failed` group (seen live through Ecoscooting, another client).
  if (['GTMS_DEL_FAILURE', 'LM_DELIVERY_FAILURE', 'PUDO_DELIVERY_FAILURE'].includes(code)) return 'failed_attempt';
  if (code === 'RT_INBOUND') return 'returned';
  const status = CAINIAO_ACTION_STATUS.get(code);
  return status ? cainiaoStageByStatus()[status] : undefined;
}

/**
 * The scans the review queue holds without their action code, from before
 * events kept it, by `normalizeStatusWording` wording without the town
 * bracket. Each is the standard wording Cainiao gives that code.
 */
const UNCODED_SCANS: ReadonlyMap<string, string> = new Map([
  ['handed over from linehaul office', 'LH_HO_OUT_SUCCESS'],
  ['leaving transit country/region', 'TD_TRANSWH_OUTBOUND'],
  ['awaiting for transit to final delivery office', 'TD_TRANS_ARRIVE_DCP'],
  ['departed from destination country/region sorting center', 'GTMS_SC_DEPART'],
]);

/** Cainiao's records that move no parcel: each keeps the stage of the scan before it. */
const NOTICES = [
  { code: 'GTMS_ORDER_INFO_UPDATE', note: "The order's delivery details changed, which moves no parcel: it keeps the stage of the scan before it." },
  { code: 'SC_TRANS_INBOUND_FAILURE', note: 'A transit sorting center\'s inbound that did not go through, worded only "Carrier update": it names no movement and no fault, so it keeps the stage of the scan before it.' },
  { code: 'LAST_MILE_ASN_NOTIFY', note: 'Cainiao\'s advance notice of the parcel to the courier that delivers it, worded "Last-mile delivery forecast" or only "Carrier update": sent after a scan and carrying no date, not a forecast of one, so it keeps the stage of the scan before it.' },
];

export const CAINIAO_NOTICE_ACTIONS: ReadonlySet<string> = new Set(NOTICES.map((notice) => notice.code));

/** The review queue uses the same per-scan mapping as the adapter. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const action = code ? cainiaoActionCode(code) : UNCODED_SCANS.get(wording.replace(/^\[[^\]]*\]\s*/, ''));
    return action ? cainiaoActionStage(action) : undefined;
  },
  gaps: NOTICES.map(({ code, note }) => ({ code, note })),
};
