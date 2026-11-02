import { classifyWording, languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES = new Map<string, ClassifiedStatus>([
  ['FPX_S_OK', { status: 'delivered', stage: 'delivered' }],
  ['FPX_D_SD', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // A partner's driver left the parcel at a pickup shop, or the shop took it over.
  ['FPX_D_SASPS', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['FPX_D_FD', { status: 'exception', stage: 'failed_attempt' }],
  ['FPX_D_DDRH', { status: 'exception', stage: 'failed_attempt' }], // The recipient was not in; a notice was left.
  // The partner could not deliver to the address given and is checking it, before 4PX's "Delivery failed".
  ['FPX_D_FDIA', { status: 'exception', stage: 'failed_attempt' }],
  // The partner's decision to send the parcel back for that address: the return is under way, not yet with the sender.
  ['FPX_M_PRTS', { status: 'exception', stage: 'exception' }],
  ['FPX_L_RPIF', { status: 'pending', stage: 'registered' }],
  ['FPX_L_SC', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_SPLS', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_SPQS', { status: 'in_transit', stage: 'accepted' }],
  ['FPX_C_AAF', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_C_ADFF', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_F_ST', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_PT', { status: 'in_transit', stage: 'in_transit' }], // Left the origin facility, awaiting the line haul.
  ['FPX_M_HA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_DFOA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_ATA', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_CRSD', { status: 'in_transit', stage: 'customs' }],
  ['FPX_I_CP', { status: 'in_transit', stage: 'customs' }],
  ['FPX_I_RCUK', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_AOPC', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_STPP', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_HQ', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_D_DFD', { status: 'in_transit', stage: 'in_transit' }], // Left the destination's national sorting centre.
  ['FPX_O_RR', { status: 'in_transit', stage: 'in_transit' }],
  ['FPX_M_IT', { status: 'in_transit', stage: 'in_transit' }],
]);
// A partner's step filed under a code that says otherwise, by code and
// `normalizeStatusWording` wording: a partner can word a move between its
// sorting centre and the office that delivers as "In transit" under 4PX's
// delivery code, days before the round.
const RESTAGED: ReadonlyMap<string, Stage> = new Map([['FPX_D_SD\u0000in transit', 'in_transit']]);
// These codes relay whatever step a partner reported, from a label to an
// arrival in the destination country, so the wording decides the stage.
const WORDED = new Set(['FPX_O_IR', 'FPX_O_IRI']);
// By `normalizeStatusWording` wording. A partner's label can name its own
// waybill: "Waybill generated for …", as Emile words it, and its order data
// the partner it went to: "Order information has been transmitted to DPD."
// Asendia Hong Kong, which flies parcels for 4PX, relays its label, then the
// manifest it makes once the parcel has left 4PX's facility. Helthjem's notice that
// the shop announced the parcel is relayed as "Parcel arrival notified".
const WORDING: ReadonlyMap<string, Stage> = new Map([['waybill generated', 'registered'], ['order data transmitted', 'registered'],
  ['label creation', 'registered'], ['manifest created', 'in_transit'], ['parcel arrival notified', 'registered']]);
const LABEL_FOR = /^waybill generated for [a-z0-9]+$|^order information has been transmitted to [a-z][a-z .-]{0,30}$/;
// Scans a partner relays without a code, by `normalizeStatusWording` wording.
// A partner's order made before it has the parcel is a label, not a receipt.
const UNCODED: ReadonlyMap<string, Stage> = new Map([
  ['order creation, order submitted, pending to receive.', 'registered'],
  ['your shipment has departed from the transit origin', 'in_transit'],
  ['your shipment has arrived at the transit destination', 'in_transit'],
]);

export interface FourPxStatus extends ClassifiedStatus {
  source: string;
}

export function fourPxStatus(code: string, description = ''): FourPxStatus | undefined {
  const restaged = RESTAGED.get(`${code}\u0000${normalizeStatusWording(description)}`);
  if (restaged) return { status: languageStageStatus(restaged), stage: restaged, source: 'carrier_map' };
  const mapped = CODES.get(code);
  if (mapped) return { ...mapped, source: 'carrier_map' };
  const uncoded = code ? undefined : UNCODED.get(normalizeStatusWording(description));
  if (uncoded) return { status: languageStageStatus(uncoded), stage: uncoded, source: 'carrier_map' };
  if (!WORDED.has(code)) return undefined;
  const exact = wordedStage(normalizeStatusWording(description));
  if (exact) return { status: languageStageStatus(exact), stage: exact, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { status: languageStageStatus(worded.stage), stage: worded.stage, source: worded.source };
}

function wordedStage(wording: string): Stage | undefined {
  return WORDING.get(wording) ?? (LABEL_FOR.test(wording) ? 'registered' : undefined);
}

/**
 * What the map says about one scan: a code it maps, the known wording of a
 * code that relays a partner's step, or a codeless scan it knows. Other
 * wording under those codes is left to the shared rules.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (!code) return UNCODED.get(wording);
    return RESTAGED.get(`${code}\u0000${wording}`) ?? CODES.get(code)?.stage ?? (WORDED.has(code) ? wordedStage(wording) : undefined);
  },
  gaps: [],
};
