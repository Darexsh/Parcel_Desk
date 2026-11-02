import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Upper case, without accents and with single spaces, as the scans are compared. */
function comparable(wording: string): string {
  return wording.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * The tracker's scan wordings. Only wordings seen on the page are mapped;
 * another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['MERCANCIA RECOGIDA', 'accepted'], // Collected from the sender.
  ['EN TRANSITO INTERNACIONAL / IN INTERNATIONAL TRANSIT', 'in_transit'],
  ['SALIDA EN RUTA NACIONAL', 'in_transit'], // Left on the line haul to the delivering branch.
  ['EL ENVIO HA LLEGADO A TU DELEGACION MAS CERCANA', 'in_transit'], // At the delivering branch.
  ['TU ENVIO ESTA EN REPARTO', 'out_for_delivery'],
  ['HAS SIDO AUSENTE', 'failed_attempt'], // The recipient was not in.
  ['DIRECCION INCORRECTA - FALTAN DATOS', 'failed_attempt'], // The address lacks details; the parcel goes out again.
  ['EL ENVIO HA SIDO ENTREGADO', 'delivered'],
  ['ENTREGADA PDA', 'delivered'], // Recorded on the courier's handheld; the progress rail's end phase reads "Entregada".
]);

// The recipient's own changes record an instruction, not a movement: the
// parcel keeps the stage of the scan before it.
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['DIRECCION CORREGIDA POR EL DESTINATARIO', 'The recipient corrected the address; it moves nothing.'],
]);

/** The receipt beside a delivery, "Recibido" and the name of whoever took the parcel. */
const RECEIPT = /^RECIBIDO(?:\s|$)/;

/**
 * The progress rail's phases, from the page's `estado`. Collection,
 * transit and delivery round are coarser than the scans and are not read; a
 * delivered parcel and one written off as missing ("falta definitiva") are
 * the carrier's own end states.
 */
const PHASES: ReadonlyMap<string, Stage> = new Map([
  ['ENTR', 'delivered'],
  ['FALT', 'exception'],
]);

// ParcelsApp's English for the tracker's scans, at the same minute as the
// tracker's own. A relayed scan keeps the tracker's wording, so both copies
// read alike.
const RELAYED: ReadonlyMap<string, string> = new Map([
  ['RECEPTION IN THE DELEGATION', 'Mercancia recogida'],
  ['OUT IN NATIONAL ROUTE', 'Salida en ruta nacional'],
]);

/** The stage Sending's wording gives a scan. */
export function sendingMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(comparable(wording));
}

/** The stage and stored wording of a scan an aggregator relays from Sending's tracker. */
export function sendingScan(label: string): { stage: Stage; wording: string } | undefined {
  const wording = RELAYED.get(comparable(label)) ?? label;
  const stage = sendingMappedStage(wording);
  return stage && { stage, wording };
}

export function isSendingNotice(wording: string): boolean {
  return NOTICES.has(comparable(wording));
}

export function isSendingReceipt(wording: string): boolean {
  return RECEIPT.test(comparable(wording));
}

/** The end state a rail phase declares, if any. */
export function sendingPhaseStage(phase: string): Stage | undefined {
  return PHASES.get(phase);
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function sendingStage(wording: string): ClassifiedWording | null {
  const mapped = sendingMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isSendingNotice(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no codes: the map reads their wording. Notices are left without a stage on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : sendingScan(wording)?.stage),
  gaps: [...NOTICES].map(([wording, note]) => ({ wording: wording.toLowerCase(), note })),
};
