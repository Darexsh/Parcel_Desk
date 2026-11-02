import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { CTTYEX_NOT_FOUND, cttyexMappedStage, cttyexStage } from '../cttyex/status.js';

/**
 * Jifan's tracker is CTTYEX's system and words the scans the same way: the
 * forwarder's steps in China, from the order data to the flight out, then the
 * destination agent's and the last-mile network's. It shows no codes.
 */
export const jifanMappedStage = cttyexMappedStage;
/** A scan's stage: the map, else the shared wording rules, else nothing. */
export const jifanStage = cttyexStage;
/** The tracker's status for a number it does not know, in Chinese and in English. */
export const JIFAN_NOT_FOUND = CTTYEX_NOT_FOUND;

/** What the map says about one scan or summary, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : jifanMappedStage(wording)),
  gaps: JIFAN_NOT_FOUND.map((wording) => ({ wording: normalizeStatusWording(wording),
    note: 'The tracker\'s status for a number it does not know, which the adapter reads as not found; never a scan.' })),
};
