import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { cneScanStage } from './parser.js';

/**
 * What the map says about one movement: its label, or its state code where no wording rule reads
 * the label, as the parser stages them. A label only the shared wording rules read stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = cneScanStage(wording, code ?? '');
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
