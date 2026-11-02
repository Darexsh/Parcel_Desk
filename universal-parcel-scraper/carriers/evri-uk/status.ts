import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { EVRI_UK_DELIVERED, evriUkCodeStage } from './parser.js';

/**
 * What the map says about one scan. Its rail sets its stage and its tracking point refines some
 * rails, so a scan's code keeps both, rail first, and stages it as the parser does. A code on a
 * rail the adapter does not know stages nothing, so the scan still reaches the review. A scan
 * stored with its tracking point alone, or without a code, is staged only by the wording both
 * tiers write for every delivery: the same point sits on rails of different stages, a ParcelShop
 * arrival being the drop-off on rail 2 and the parcel awaiting collection on 4_SHOP.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code?.includes('/') ? evriUkCodeStage(code)
    : wording === normalizeStatusWording(EVRI_UK_DELIVERED) ? 'delivered' : undefined),
  gaps: [],
};
