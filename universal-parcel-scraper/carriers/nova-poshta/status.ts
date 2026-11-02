import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { movementStage } from './parser.js';

/** The codes a return's event can carry: the stored scan keeps the code, not the event. */
const RETURN_CODES = ['9', '102'];

/**
 * What the map says about one movement: its code, as the movement feed's parser reads it. Code 9
 * also closes a return at the sending branch and code 102 opens it, by an event name the stored
 * scan does not keep, so both stay open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && !RETURN_CODES.includes(code) ? movementStage(code) : undefined),
  gaps: [
    { code: '9', note: 'Delivered, or a return received at the sending branch when its event is ShipmentReturnReceived: the stored scan does not keep the event.' },
    { code: '102', note: 'A return to the sender when its event is OrderCargoReturn: the stored scan does not keep the event.' },
  ],
};
