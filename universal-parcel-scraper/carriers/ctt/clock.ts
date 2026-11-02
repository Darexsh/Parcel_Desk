import { countryTimeZone, regionHasTown } from '../../core/time/index.js';

/**
 * CTT's clocks. CTT dates a scan with the wall clock of the place it happened
 * and writes it with a Z: its tracker is an OutSystems app, whose DateTime
 * values travel as UTC strings, and its page shows the digits as they are
 * whatever the viewer's zone. UPU's tracking has the same wall clocks for
 * CTT's posting and dispatch, and 17TRACK reads them on Lisbon's clock
 * (checked 2026-10-10). The destination post's scans keep its own wall clock:
 * an Italian delivery comes at the Italian office's time. So do the origin
 * post's scans of mail from abroad.
 */

/** A UPU office of exchange leading a location: "PTLISA - (OUTRO) LISBOA". */
const OFFICE = /^([A-Z]{2})[A-Z0-9]{4}(?=\s+-\s)/;
/** CTT's own sites: a sorting centre, also written C.O., a delivery centre (CDP), a shop or a postal point. */
const CTT_SITE = /\b(?:CTT|CDP|centro operacional|centro de distribui[cç][aã]o)\b|\bC\.O\.(?!\S)/i;
/** A Portuguese postcode; 9500 to 9999 are the Azores. */
const POSTCODE = /(?<!\d)(\d{4})(?:-\d{3})?(?!\d)/;

/**
 * The clock of a scan in Portugal: the Azores keep one an hour behind the
 * mainland and Madeira. A location names them by postcode or by a town only
 * the islands have.
 */
export function portugalZone(location: string): string {
  const postcode = POSTCODE.exec(location)?.[1];
  if (postcode) return Number(postcode) >= 9500 ? 'Atlantic/Azores' : 'Europe/Lisbon';
  const town = location.replace(OFFICE, '').replace(/\([^)]*\)/g, ' ').replace(/^[\s\d-]+/, '')
    .replace(/\b(?:loja|ponto|centro operacional|CTT|CDP)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return town && regionHasTown('PT-20', town) ? 'Atlantic/Azores' : 'Europe/Lisbon';
}

/**
 * One of CTT Express's agencies in Spain, as CTT names it on a parcel CTT
 * Express hands over: a six-digit code starting 00, like every code in CTT
 * Express's agency list, and its kind ("009999 - (PL) CENTRO DE TRATAMIENTO
 * ADUANERO"). CTT gives such a scan Madrid's wall clock: CTT Express's own
 * tracker dates the same arrival 17:12:27.063Z where CTT shows 19:12:27.
 */
const CTT_EXPRESS_AGENCY = /^00\d{4}\s+-\s+\(/;

/**
 * Madrid, which CTT names on the shipment record CTT Express sends it. The record keeps
 * Madrid's wall clock: CTT Express's own tracker dates it two hours before CTT's digits in
 * summer time.
 */
const MADRID = /^madrid$/i;

/** Whether a location names one of CTT Express's agencies, not one of CTT's own sites. */
export function isCttExpressAgency(location: string): boolean {
  return CTT_EXPRESS_AGENCY.test(location) && !CTT_SITE.test(location);
}

/** The acceptance CTT records with no place as a CTT Express agency takes a parcel in comes up to this long before. */
const AGENCY_INTAKE_MS = 60_000;

/**
 * Whether a CTT scan with no place, at `at`, is that acceptance: at most a minute before one of
 * `agencyScans`, the agencies' scans. Both are wall clocks read as UTC, only to compare them.
 * It is on Madrid's clock, as the agency's scan is.
 */
export function agencyIntake(at: number, agencyScans: readonly number[]): boolean {
  return agencyScans.some((agency) => agency - at >= 0 && agency - at <= AGENCY_INTAKE_MS);
}

/**
 * The clock a CTT scan's location itself names: the country of the office of
 * exchange leading it, when that is Portugal or one of `countries` (the
 * parcel's), Madrid's for Madrid or one of CTT Express's agencies, else
 * Portugal's for one of CTT's own sites. Null when the location does not say.
 * Providers' copies of CTT's scans keep CTT's digits, so they take the same clocks.
 */
export function cttSiteZone(location: string, countries: readonly (string | null)[]): string | null {
  const office = OFFICE.exec(location)?.[1];
  if (office === 'PT' || (office && countries.includes(office))) {
    return office === 'PT' ? portugalZone(location) : countryTimeZone(office);
  }
  if (MADRID.test(location.trim()) || isCttExpressAgency(location)) return 'Europe/Madrid';
  return CTT_SITE.test(location) ? portugalZone(location) : null;
}
