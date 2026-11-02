import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: Readonly<Record<string, Stage>> = {
  AVAIL: 'registered', DEPSHIP: 'accepted', ARRTERM: 'in_transit', DEPARTERM: 'in_transit', DOCKED: 'in_transit',
  ARRZONE: 'in_transit', OUTFORDELV: 'out_for_delivery', ARRCONS: 'out_for_delivery', COMPLETE: 'delivered',
};
export const statusMap: CarrierStatusMap = { stage: code => code && Object.hasOwn(STAGES, code) ? STAGES[code] : undefined,
  gaps: ['DISP', 'ARRSHIP', 'DEPCONS', 'POSITION'].map(code => ({ code, note: 'Driver activity alone does not establish a shipment milestone.' })) };
