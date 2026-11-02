import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Situation codes (`idDesc`) of Redpack's tracking service and the stage each
 * means. A failed delivery and a shipment-control hold carry their reason in
 * brackets after the situation, which the code reads past.
 */
const CODES: ReadonlyMap<string, Stage | null> = new Map<string, Stage | null>([
  ['1', 'delivered'],
  ['3', 'out_for_delivery'],
  ['8', 'failed_attempt'],
  ['9', 'registered'],
  ['42', 'in_transit'],
  ['43', 'in_transit'],
  // The branch's shipment-control desk holds the parcel, to correct an address for instance.
  ['125', null],
]);

/**
 * Situations by wording, for a scan without a code (the pickup row carries
 * code 0) or with one the map does not know. The wordings without a code
 * here come from Redpack's tracker page.
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'entregado': 'delivered',
  'embarcado en ruta de entrega': 'out_for_delivery',
  'en ruta de entrega': 'out_for_delivery',
  'no entregado': 'failed_attempt',
  'registrado en sistema': 'registered',
  'en preparacion': 'registered',
  'envio recolectado': 'accepted',
  'recolectado': 'accepted',
  'recibido en oficina': 'in_transit',
  'salida de oficina': 'in_transit',
  'auditado': 'in_transit',
  'consolidado': 'in_transit',
};

/** A situation's wording without its bracketed reason or accents, in lower case. */
function wordingKey(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s*\([^()]*\)$/, '');
}

/** The stage of one scan: its code decides when the map knows it, its wording otherwise. */
export function redpackStage(code: string | null, wording: string): Stage | undefined {
  if (code !== null && CODES.has(code)) return CODES.get(code) ?? undefined;
  const key = wordingKey(wording);
  return Object.hasOwn(WORDINGS, key) ? WORDINGS[key] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: redpackStage,
  gaps: [
    { code: '125', note: "The parcel is held at the branch's shipment-control desk, to correct an address for instance; it does not move." },
    { wording: 'no recolectado', note: "The courier did not collect the parcel from the sender, so it is still with the sender." },
  ],
};
