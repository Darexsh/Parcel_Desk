import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Short forms of the guest tracker's Indonesian messages, without recipient or courier names.
const CODES = new Map<string, { wording: string; stage: Stage }>([
  ['100', { wording: 'Pickup sudah di-request oleh shipper', stage: 'registered' }],
  ['150', { wording: 'SATRIA sudah ditugaskan dan paket akan segera di-pickup', stage: 'registered' }],
  ['200', { wording: 'Paket sudah di-pickup oleh SATRIA', stage: 'accepted' }],
  ['240', { wording: 'SATRIA sudah ditugaskan dan paket akan segera diantar ke penerima', stage: 'out_for_delivery' }],
  ['250', { wording: 'Delivery sukses', stage: 'delivered' }],
  ['300', { wording: 'Paket sedang diproses di Hub', stage: 'in_transit' }],
  ['332', { wording: 'Paket menuju ke Hub (proses transit)', stage: 'in_transit' }],
  ['334', { wording: 'Paket tiba di Hub (proses transit)', stage: 'in_transit' }],
  ['500', { wording: 'Paket tidak dapat dikirimkan dan sedang tertahan di hub', stage: 'exception' }],
]);

export function anterajaStatus(code: string): { wording: string; stage?: Stage } {
  return CODES.get(code) ?? { wording: `Pembaruan status Anteraja (${code})` };
}
export const statusMap: CarrierStatusMap = { stage: code => code ? CODES.get(code)?.stage : undefined, gaps: [] };
