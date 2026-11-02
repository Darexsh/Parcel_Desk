/**
 * InPost status vocabulary for the public inposteasy.com hub.
 *
 * Codes are `<PHASE>.<NNNN>` strings (CRE creation, FMD first mile, MMD middle
 * mile, LMD last mile, RTS return to sender, EOL end of life). The
 * cross-border vocabulary is explicitly still being observed, so an unmapped
 * code yields no stage at all: the event keeps its raw wording, the result
 * reports `unknown`, and the sync classifies and records it.
 *
 * Provenance: derived from the prior-art client
 * https://github.com/ha-parcel-integrations/ha-inpost (MIT,
 * `TRACKING_STATUS_MAP`), live-confirmed on IT/PT/GB consignments 2026-08-31.
 */
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const TRACKING_STATUS: Record<string, ClassifiedStatus> = {
  // Creation and handover: the sender posts the parcel at a locker or pickup
  // point, or a courier collects it.
  'CRE.1001': { status: 'pending', stage: 'registered' },
  'FMD.1001': { status: 'in_transit', stage: 'accepted' },
  'FMD.1002': { status: 'in_transit', stage: 'accepted' },
  // Logistics-centre movement.
  'MMD.1001': { status: 'in_transit', stage: 'in_transit' },
  'MMD.1002': { status: 'in_transit', stage: 'in_transit' },
  'MMD.1003': { status: 'in_transit', stage: 'in_transit' },
  'MMD.1004': { status: 'in_transit', stage: 'in_transit' },
  // Last-mile, redirects and collection. LMD.1001 hands the parcel to the
  // courier for delivery, to the door or to a locker.
  'LMD.1001': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'LMD.1002': { status: 'in_transit', stage: 'in_transit' },
  'LMD.3006': { status: 'in_transit', stage: 'in_transit' },
  'LMD.3014': { status: 'in_transit', stage: 'in_transit' },
  'LMD.1004': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'LMD.1005': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'LMD.9001': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'LMD.9002': { status: 'exception', stage: 'failed_attempt' },
  // The recipient refused the parcel.
  'LMD.9006': { status: 'exception', stage: 'failed_attempt' },
  // The courier could not deliver the parcel and takes it back.
  'LMD.9015': { status: 'exception', stage: 'failed_attempt' },
  'LMD.9014': { status: 'exception', stage: 'returned' },
  // A parcel whose locker is full waits in a nearby one for the same code
  // (LMD.9012). Once that storage expires (LMD.3009), InPost takes it back to
  // the chosen locker (LMD.3005).
  'LMD.9012': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  'LMD.3009': { status: 'in_transit', stage: 'in_transit' },
  'LMD.3005': { status: 'in_transit', stage: 'in_transit' },
  // Terminal outcomes.
  'EOL.1001': { status: 'delivered', stage: 'delivered' },
  'EOL.1003': { status: 'delivered', stage: 'delivered' },
  'EOL.9001': { status: 'exception', stage: 'failed_attempt' },
  'RTS.1001': { status: 'exception', stage: 'returned' },
  'RTS.1002': { status: 'exception', stage: 'returned' },
};

/**
 * Codes that say nothing of how far the parcel got, so they keep the stage of
 * the event before it. LMD.3013 ("Paczka przekierowana") changes where it goes
 * and comes straight after creation as well as later; INF.9001 ("Possible
 * delivery delay") is a notice between two moves.
 */
const STAGE_KEEPERS = new Set(['LMD.3013', 'INF.9001']);

/** Whether an InPost hub status code keeps the stage the parcel had before it. */
export function keepsInpostStage(code: string): boolean {
  return STAGE_KEEPERS.has(code);
}

/** The stage and status for an InPost hub status code, or undefined when unmapped. */
export function classifyInpostStatus(code: string): ClassifiedStatus | undefined {
  return TRACKING_STATUS[code];
}

/** A hub status code. ShipX's statuses give a summary, never a scan. */
const HUB_CODE = /^[A-Z]{3}\.\d{4}$/;

/** The hub's wording of a code, as recorded in statuses.json. */
const HUB_WORDINGS = statuses.entries.flatMap((entry) => (entry.wording && HUB_CODE.test(entry.code)
  ? [{ code: entry.code, wording: normalizeStatusWording(entry.wording), note: entry.note }]
  : []));

/** The stage of a hub wording through the codes it comes with: none when they disagree or one has none. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const { code, wording } of HUB_WORDINGS) {
  const stage = classifyInpostStatus(code)?.stage;
  STAGE_BY_WORDING.set(wording, STAGE_BY_WORDING.has(wording) && STAGE_BY_WORDING.get(wording) !== stage ? undefined : stage);
}

/** Why a redirect or a delay notice has no stage of its own, by its code. */
const KEEPER_NOTES = new Map(HUB_WORDINGS.filter(({ code }) => keepsInpostStage(code)).map(({ code, note }) => [code, note]));

/**
 * What the map says about one scan. A hub scan keeps its code, which stages it; a copy without
 * one is staged by its wording through the code it comes with, and a scan the hub sent without
 * wording keeps its code as its wording. A redirect or a delay notice takes the stage of the scan
 * before it, which the stored scan does not keep.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const hubCode = (code && HUB_CODE.test(code) ? code : wording).toLocaleUpperCase('en-US');
    return HUB_CODE.test(hubCode) ? classifyInpostStatus(hubCode)?.stage : STAGE_BY_WORDING.get(wording);
  },
  gaps: [
    ...[...STAGE_KEEPERS].map((code) => ({ code, note: KEEPER_NOTES.get(code) ?? 'Takes the stage of the scan before it, which the stored scan does not keep.' })),
    ...HUB_WORDINGS.filter(({ code }) => keepsInpostStage(code)).map(({ wording, note }) => ({ wording, note })),
  ],
};
