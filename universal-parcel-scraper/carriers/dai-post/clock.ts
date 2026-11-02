import { countryTimeZone } from '../../core/time/index.js';

// New Zealand's Chatham Islands keep their own clock; DAI Post's New Zealand
// scans name mainland depots, so a scan naming the Chathams keeps its clock local.
const LANE_ZONES: Readonly<Record<string, string>> = { NZ: 'Pacific/Auckland' };

// The label data's wordings (CI02), for a relay that drops the code.
const LABEL_DATA = /^(?:we[’']ve received your delivery details\b|customer label information received\b)/i;

/**
 * The zone a DAI Post scan's wall clock is read in: its country's, when it keeps
 * one clock. Null keeps the clock local: for Australia, the US and unplaced
 * scans, and for the label data (CI02), whose clock matched a shipper's UTC
 * dispatch for some parcels and the origin hub's for others. Asendia relays
 * these clocks too.
 */
export function daiPostScanZone(code: string, country: string, place: string): string | null {
  if (code === 'CI02' || !country) return null;
  if (country === 'NZ') return /\bchatham/i.test(place) ? null : LANE_ZONES.NZ!;
  return countryTimeZone(country);
}

/**
 * The zone of a DAI Post scan a relay copies with its wording and location
 * ("Mansfield, Brisbane, AU"), the town and country code the page shows.
 */
export function daiPostRelayZone(description: string, location: string): string | null {
  const country = /(?:^|,\s*)([A-Z]{2})$/.exec(location.trim())?.[1] ?? '';
  return daiPostScanZone(LABEL_DATA.test(description.trim()) ? 'CI02' : '', country, location);
}
