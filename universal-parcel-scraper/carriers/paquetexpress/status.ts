import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event codes (`eventoId`) of a parcel's history. A label made through
 * Paquetexpress's web services (SWB) and a pickup request (HCR, HCP) come
 * before the parcel is handed over; a parcel is "documentada" (BOK) when the
 * sender hands it in at a branch's counter, and collected (HCM, HCA) when a
 * driver picks it up. A delivery at the door (HDC), at the branch (BDL) or
 * paid there by the recipient (PDC) ends the journey.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  SWB: 'registered',
  HCR: 'registered',
  HCP: 'registered',
  BOK: 'accepted',
  HCM: 'accepted',
  HCA: 'accepted',
  TRN: 'in_transit',
  TTM: 'in_transit',
  HLP: 'in_transit',
  HTC: 'out_for_delivery',
  HDC: 'delivered',
  BDL: 'delivered',
  PDC: 'delivered',
};

/** The wording of each mapped code, without the person it names; used when a row comes without one. */
const LABELS: Readonly<Record<string, string>> = {
  SWB: 'Documentación De Servicios Web',
  HCR: 'Solicitud De Rad',
  HCP: 'Recolección Planeada',
  BOK: 'Documentada',
  HCM: 'Recolección Realizada',
  HCA: 'Confirmación De Recolección En Almacen',
  HCC: 'Rad Cancelación',
  TRN: 'Mercancía En Tránsito',
  TTM: 'Transbordo De Remolque',
  WHU: 'Recibida En Sucursal',
  HLP: 'Planeado Para Entrega A Domicilio',
  HTC: 'En Ruta De Entrega A Domicilio',
  HDC: 'Mercancía Entregada A Domicilio',
  BDL: 'Entregada En Sucursal',
  PDC: 'Pagada En Destino (Contado)',
};

/** Rows that move nothing: the parcel keeps the stage of the row before them. */
const QUIET: Readonly<Record<string, string>> = {
  HCC: 'Rad Cancelación: the pickup request is cancelled, which moves nothing; the parcel can still be handed in.',
};

/** Rows the tracker leaves out of the history, which the adapter drops as well. */
const HIDDEN: Readonly<Record<string, string>> = {
  NRC: 'The tracker leaves these rows out of the history, so the adapter drops them unread.',
};

/** Codes whose stage depends on the delivery type and wording, as on the tracker. */
const CONTEXTUAL: Readonly<Record<string, string>> = {
  WHU: 'Recibida En Sucursal: a transshipment or destination branch, in transit; at the destination branch of a parcel to collect there (ENT_OCU), ready for pickup.',
};

/** The stage the map gives a code on its own, if it knows one. */
export function paquetexpressScanStage(code: string): Stage | undefined {
  return Object.hasOwn(SCANS, code) ? SCANS[code] : undefined;
}

/** Whether a row's code moves nothing. */
export function paquetexpressQuiet(code: string): boolean {
  return Object.hasOwn(QUIET, code);
}

/** Whether the tracker leaves a row with this code out of the history. */
export function paquetexpressHidden(code: string): boolean {
  return Object.hasOwn(HIDDEN, code);
}

/** Whether the map knows a code, so its wording keeps everything before the person it names. */
export function paquetexpressKnown(code: string): boolean {
  return Object.hasOwn(LABELS, code);
}

/** The wording of a known code without the person it names, if the map has one. */
export function paquetexpressLabel(code: string): string | undefined {
  return Object.hasOwn(LABELS, code) ? LABELS[code] : undefined;
}

/**
 * A row's stage from its code, the delivery type (`ENT_EAD` to the door,
 * `ENT_OCU` to collect at the branch) and its wording: `quiet` when it moves
 * nothing, else the map's stage, else the shared wording rules' (null when
 * neither knows it).
 */
export function paquetexpressStage(code: string, wording: string, delivery: string): ClassifiedWording | 'quiet' | null {
  if (paquetexpressQuiet(code)) return 'quiet';
  if (code === 'WHU') {
    return { stage: delivery === 'ENT_OCU' && /\bdestino\b/i.test(wording) ? 'ready_for_pickup' : 'in_transit', source: 'carrier_map' };
  }
  const mapped = paquetexpressScanStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * What the map says about one row, by its code alone. A cancelled pickup moves
 * nothing, a hidden row is never read, and a branch's receipt depends on the
 * delivery type.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? paquetexpressScanStage(code) : undefined),
  gaps: [...Object.entries(QUIET), ...Object.entries(HIDDEN), ...Object.entries(CONTEXTUAL)].map(([code, note]) => ({ code, note })),
};
