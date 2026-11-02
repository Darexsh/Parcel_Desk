import type { CarrierResult } from '../../core/result/index.js';
import { normalizeCourierPortalNumber, parseCourierPortal, type CourierPortalTenant } from './portal.js';
import { logisimpleStage } from './status.js';

export const PROVIDER = 'Logisimple';
export const CARRIER = 'logisimple';
export const LOGISIMPLE_ORIGIN = 'https://portal.logisimple.pt';

export const LOGISIMPLE: CourierPortalTenant = {
  carrier: CARRIER, provider: PROVIDER, origin: LOGISIMPLE_ORIGIN,
  // The portal's form gives twelve-digit examples, and customers quote twelve-digit numbers.
  layout: /^\d{12}$/,
  layoutMessage: 'Logisimple shipment codes are twelve digits',
  stage: logisimpleStage,
};

export const normalizeLogisimpleNumber = (raw: string): string => normalizeCourierPortalNumber(raw, LOGISIMPLE);
export const parseLogisimple = (html: string, number: string): CarrierResult => parseCourierPortal(html, number, LOGISIMPLE);
