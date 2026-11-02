import { clean } from '../../core/transport/text.js';

// A name iMile opens a scan with, in 【】 and sometimes also in <>: "【<BOG>】 Clearance start.".
const OPENING_NAME = /^【\s*<?([^】<>]*?)>?\s*】\s*/;
// The other names in 【】, and the reasons and dates in <>, which the page shows as typed.
const BRACKETED = /【\s*<?([^】<>]*?)>?\s*】|<([^<>]{1,120})>/g;
// The flight booked for the parcel with its planned clocks, alone or after the scan it follows.
const FLIGHT_SCHEDULE = /(?:^|\s*[,，;；]\s*)Flight Schedule ETD\b[\s\S]*$/i;

/**
 * A scan's wording without iMile's brackets. A name opening the scan is its
 * centre, which its location already shows, or else heads the sentence
 * ("BOG: Clearance start."); the other names, reasons and dates keep their
 * words. A flight booked for the parcel is still to come and is left out, so
 * a row that only books one has no wording. Reading it again changes nothing.
 */
export function imileDisplayWording(wording: string, location: string): string {
  const opening = OPENING_NAME.exec(wording);
  const name = opening?.[1]!.trim() ?? '';
  const said = clean((opening ? wording.slice(opening[0].length) : wording)
    .replace(BRACKETED, (_, inner = '', reason = '') => ` ${String(inner || reason).trim()} `)
    .replace(/\s+([,，;；.。])/g, '$1'));
  const rest = said.replace(FLIGHT_SCHEDULE, '');
  if (said && !rest) return '';
  if (!name || name.toLowerCase() === location.trim().toLowerCase()) return rest || name;
  return rest ? `${name}: ${rest}` : name;
}
