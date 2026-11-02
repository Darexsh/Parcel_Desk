import { countryTimeZone } from '../../core/time/index.js';

/**
 * Events Swiss Post relays from the destination post of a parcel it sends
 * abroad: arrival in the destination country, its customs, sorting and
 * delivery rounds. With no city, postcode or country they carry the
 * destination office's wall clock under Swiss Post's offset: an El Salvador
 * delivery round at 12:26 local came as 12:26 +02:00. UPU's record has the
 * same 12:26 at El Salvador's office, and Correos de El Salvador's own tracker
 * dates it 18:26:18 UTC (checked 2026-10-11). On an item to China, customs
 * (901, 902) came at the 11:05 and 14:30 UPU gives Beijing's and Hangzhou's
 * offices. Swiss Post's own unlocated events (813, 915) keep its clock.
 */
export const DESTINATION_EVENTS: ReadonlySet<string> = new Set(['901', '902', '909', '918', '919', '920', '921', '923', '924', '926',
  '934', '938']);

/** The English wording of those events, for relays that give no code (Ship24, 17TRACK, Postal Ninja). */
const DESTINATION_WORDING = new RegExp('^(?:arrival in destination country|customs clearance process underway|sorting - forwarding'
  + '|arrival at the processing/collection point|delivery failed: (?:recipient unknown|recipient absent|shipment undeliverable)'
  + '|retention period was extended by recipient|delivered)$', 'i');

/**
 * Outward offices of exchange abroad, by the name Swiss Post gives them, and their clock.
 * On a parcel from abroad their scans carry the office's wall clock under Swiss Post's
 * offset: a departure from London's office ("LON E ET BEA", UPU's GBLONE) at 17:57 local
 * came as 17:57 +02:00, and UPU's record has it at 17:57 +01:00 (checked 2026-10-23). The
 * reply names no origin, and the barcode's post can run an office in another country, so
 * the office's name is what places them. London's offices show as "LON" and a letter.
 */
const ORIGIN_OFFICES: ReadonlyArray<readonly [RegExp, string]> = [[/^LON [A-Z]\b/, 'Europe/London']];

/**
 * The sender's electronic notice that a letter will shortly be handed over (859). It comes from
 * Chinese consolidators posting their letters in Switzerland through their European hubs, and
 * carries the sending system's Beijing wall clock under Swiss Post's offset: Cainiao's notice on
 * a letter from its Dutch hub read 18:12 +01:00 in a reply Swiss Post gave at 13:58 its own time,
 * hours before it, and on Beijing's clock it is 11:12. The reply may name no sender, the hub's
 * country or Switzerland: one naming Switzerland, with the hub's deposit at 10:56 +01:00, had
 * the notice at 19:16 +01:00 when Swiss Post answered at 14:21. Senders in Switzerland give
 * their notice another code (600), on Swiss Post's clock, as parcels do.
 */
export const PRE_ADVICE = '859';
export const PRE_ADVICE_ZONE = 'Asia/Shanghai';

/** The clock of an origin office of exchange Swiss Post names, or null when none is listed for it. */
export function swissPostOriginZone(location: string): string | null {
  const name = location.trim().toUpperCase();
  return ORIGIN_OFFICES.find(([office]) => office.test(name))?.[1] ?? null;
}

/**
 * The clock of a Swiss Post scan as a relay gives it, when it is the
 * destination post's: worded as one of those events, with no location, on an
 * item bound for `destination`, another country, which keeps one clock. Null
 * otherwise, when the relay's reading stays.
 */
export function swissPostDestinationZone(wording: string, location: string, destination: string | null): string | null {
  if (location.trim() || !destination || destination === 'CH' || !DESTINATION_WORDING.test(wording.trim())) return null;
  return countryTimeZone(destination);
}
