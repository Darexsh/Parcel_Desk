import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracking page's scan wording, mapped whole. The page gives no status
 * code. The shared classifier leaves most of these without a stage, and it
 * would read a pickup point's hand-over to DPD as a delivery.
 */
export const DPD_IE_SCANS: Readonly<Record<string, Stage>> = {
  // The sender's data, before DPD has the parcel.
  'Order received / DPD awaiting parcel': 'registered',
  'Order data received from sender': 'registered',
  'Parcel data received from sender': 'registered',
  // The sender left the parcel at a Pickup shop.
  'Customer dropped parcel at Pick Up Point': 'accepted',
  'Your parcel is travelling through the DPD network': 'in_transit',
  'International Hub - In Transit': 'in_transit',
  // A parcel from DPD's UK network arriving at an Irish depot.
  'DPD IE UK Inbound': 'in_transit',
  'Scanned out of HUB': 'in_transit',
  'Security Scan': 'in_transit',
  'Parcel going through Customs process': 'customs',
  // The page cuts the delivery window after this wording; the parser removes it.
  'Your parcel is on a van and due for delivery': 'out_for_delivery',
  "We tried to deliver but you weren't home": 'failed_attempt',
  Delivered: 'delivered',
  'Delivered Consignee': 'delivered',
  'Delivered Letterbox': 'delivered',
  'Delivered Safe Place': 'delivered',
};

/** A DPD driver's collection: it accepts the parcel, unless an earlier scan already did or moved it. */
export const DPD_IE_DRIVER_COLLECTION = 'Parcel collected by DPD Driver';

/**
 * A Pickup shop handing a parcel over. After the sender dropped it at the
 * shop, DPD takes it on; any other time it may be the recipient's
 * collection, which the wording alone does not tell.
 */
export const DPD_IE_POINT_COLLECTION = 'Your parcel has been collected from the Pickup Point';

/** The sender's drop-off at a Pickup shop, after which the shop's hand-over is DPD's collection. */
export const DPD_IE_POINT_DROP_OFF = 'Customer dropped parcel at Pick Up Point';

// A new delivery day, not a movement: the parcel keeps its stage.
const NOTICES = ['Delivery of your parcel has been rescheduled'];

const SCANS = new Map(Object.entries(DPD_IE_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));

/** The stage the wording alone gives a scan, if any. */
export function dpdIeScanStage(wording: string): Stage | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

export function isDpdIeNotice(wording: string): boolean {
  return NOTICE_KEYS.has(normalizeStatusWording(wording));
}

/**
 * What the map says about one scan. The two collections take their stage
 * from the scans before them, so the map does not know it from their
 * wording; notices are left without a stage on purpose.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(wording),
  gaps: [...NOTICE_KEYS].map(wording => ({
    wording, note: 'A new delivery day, not a movement: the parcel keeps the stage it had.',
  })),
};
