import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { GETONLINE_MAX_BYTES, getOnlineScanZone, parseGetOnline, type GetOnlineMember } from './getonline.js';
import { skynetStage } from './status.js';

export const PROVIDER = 'SkyNet Worldwide Express';
export const SKYNET_MAX_BYTES = GETONLINE_MAX_BYTES;
/**
 * The network's tracking page, hosted by Frontier Force. `stid=skynet` picks
 * SkyNet's records as well as its branding: another member's id does not find
 * a SkyNet shipment.
 */
export const SKYNET_TRACKER = 'https://tracking.frontierforce.com/go/plm-tracking';
// The tracker takes any reference and checks none; this keeps out what cannot be one.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,20}$/;
// A run of zeros is a placeholder, not an air waybill.
const PLACEHOLDER = /^0+$/;

/** A reference for SkyNet's tracker: eight to twenty letters and digits with at least one digit, not all zeros. */
export function normalizeSkynetNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number) || PLACEHOLDER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyNet air waybills are eight to twenty letters and digits');
  return number;
}

export const SKYNET: GetOnlineMember = {
  carrier: 'skynet-worldwide', provider: PROVIDER, name: 'SkyNet', stid: 'skynet', tracker: SKYNET_TRACKER,
  normalize: normalizeSkynetNumber, stage: skynetStage,
};

/** The zone of a scan's location, when its country keeps one clock. */
export const skynetScanZone = getOnlineScanZone;

/** The tracker's page for one air waybill, `go/plm-tracking?stid=skynet&cn=`. */
export const parseSkynet = (html: string, rawNumber: string): CarrierResult => parseGetOnline(html, rawNumber, SKYNET);
