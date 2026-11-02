/**
 * Timestamp parsing with an explicit timezone policy.
 *
 * Providers disagree about time: some send offsets, some send naive wall-clock
 * strings in a known zone, some send epoch milliseconds, some only a calendar
 * day. Each helper below implements one policy and documents its limits so an
 * adapter states which one applies instead of re-implementing the parsing.
 * Every helper returns `null` rather than guessing a zone. A wall time the
 * clocks repeat when they go back reads as its first occurrence.
 */
import { DateTime } from 'luxon';
import { REGION_TOWNS } from '../../generated/regionTowns.js';
import { clean } from '../transport/text.js';
import { townName } from './townNames.js';

export interface ParsedTime {
  /** ISO 8601 with the source offset preserved and no milliseconds. */
  iso: string;
  /** Epoch milliseconds, for ordering. */
  timestamp: number;
}

export const EXPLICIT_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A wall-clock reading settled on the first of the two instants it names when
 * the clocks go back, so the repeated hour reads the same in every season:
 * Luxon otherwise picks by the offset the zone has when the code runs. Any
 * other reading is returned as it is. Pass a time parsed from a wall clock,
 * never an instant shown in a zone, whose second occurrence is no guess.
 */
export function firstOccurrence<Time extends DateTime>(wall: Time): Time {
  return wall.getPossibleOffsets().reduce((first, other) => (other.toMillis() < first.toMillis() ? other : first));
}

function fromDateTime(parsed: DateTime): ParsedTime | null {
  const iso = parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

/**
 * ISO strings that carry their own offset. Use for cross-border lanes where
 * stamping a zone would be wrong; offset-less values are rejected.
 */
export function explicitOffsetTime(value: unknown, maxLength = 64): ParsedTime | null {
  const raw = clean(value, maxLength);
  if (!raw || !EXPLICIT_OFFSET_PATTERN.test(raw)) return null;
  return fromDateTime(DateTime.fromISO(raw, { setZone: true }));
}

/**
 * Naive wall-clock strings in one known zone. Use when the provider documents
 * (or live checks show) a single backend zone; note regional caveats in the
 * adapter.
 */
export function zonedTime(
  value: unknown,
  format: string,
  zone: string,
  options: { locale?: string; maxLength?: number } = {},
): ParsedTime | null {
  const raw = clean(value, options.maxLength ?? 64);
  if (!raw) return null;
  return fromDateTime(firstOccurrence(DateTime.fromFormat(raw, format, { zone, locale: options.locale })));
}

/** ISO strings that may or may not carry an offset; offset-less values are read in `zone`. */
export function isoTime(value: unknown, zone: string, maxLength = 64): ParsedTime | null {
  const raw = clean(value, maxLength);
  if (!raw) return null;
  const parsed = EXPLICIT_OFFSET_PATTERN.test(raw)
    ? DateTime.fromISO(raw, { setZone: true })
    : firstOccurrence(DateTime.fromISO(raw, { zone }));
  return fromDateTime(parsed);
}

/** The digits of a labeled instant read in UTC, or of an offset-less value as given. */
function labeledDigits(value: unknown, maxLength: number): DateTime | null {
  const raw = clean(value, maxLength);
  if (!raw) return null;
  const labeled = EXPLICIT_OFFSET_PATTERN.test(raw)
    ? DateTime.fromISO(raw, { setZone: true }).toUTC()
    : DateTime.fromISO(raw, { zone: 'utc' });
  return labeled.isValid ? labeled : null;
}

/**
 * Wall-clock times a provider labels as UTC (or with an offset of its own)
 * although they are the scan's local time: ParcelsApp and PostNL do this. The
 * digits of the labeled instant, read in UTC, are re-read in `zone`.
 * Offset-less values are read in `zone` directly.
 */
export function mislabeledLocalTime(value: unknown, zone: string, maxLength = 64): ParsedTime | null {
  const labeled = labeledDigits(value, maxLength);
  if (!labeled) return null;
  const { year, month, day, hour, minute, second, millisecond } = labeled;
  return fromDateTime(firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute, second, millisecond }, { zone })));
}

/** The wall clock `mislabeledLocalTime` re-reads, as an offset-less ISO string. */
export function mislabeledWallTime(value: unknown, maxLength = 64): string | null {
  return labeledDigits(value, maxLength)?.toISO({ includeOffset: false }) ?? null;
}

/**
 * One zone for several that keep the same clock at `wallIso`, an offset-less
 * wall time: the first zone when every zone reads it as the same instant.
 * Null when none is given, a zone or the time is invalid, the time carries an
 * offset (every zone would agree), or the zones disagree at that moment, as
 * Zurich and London always do.
 */
export function sharedClockZone(zones: readonly string[], wallIso: string): string | null {
  if (!zones.length || EXPLICIT_OFFSET_PATTERN.test(wallIso)) return null;
  const instants = zones.map((zone) => firstOccurrence(DateTime.fromISO(wallIso, { zone })));
  const first = instants[0]!.toMillis();
  return instants.every((instant) => instant.isValid && instant.toMillis() === first) ? zones[0]! : null;
}

/** A scan's instant when the feed states it, else the readings its clock may have, likeliest first. */
export interface FeedClock {
  known?: ParsedTime | null;
  guesses?: readonly (ParsedTime | null)[];
}

// Some scanners run early; the host flags a scan only past the same hour.
const CLOCK_SKEW_MS = 3_600_000;

/**
 * Settles guessed clocks against the feed itself, given newest first. A guess
 * stands only if it is not after the lookup (`readAt`, give or take an hour of
 * skew) and keeps the feed's order: not after the nearest newer scan with a
 * known instant, not before the nearest older one. Each scan gets its known
 * instant or its first guess that stands; null when none does.
 */
export function settleGuessedClocks(scans: readonly FeedClock[], readAt: number): (ParsedTime | null)[] {
  const known = scans.map((scan) => scan.known ?? null);
  const nearest = (from: number, step: number): number | undefined => {
    for (let index = from; index >= 0 && index < known.length; index += step) {
      if (known[index]) return known[index]!.timestamp;
    }
    return undefined;
  };
  return scans.map((scan, index) => {
    if (scan.known) return scan.known;
    const newer = nearest(index - 1, -1);
    const older = nearest(index + 1, 1);
    return scan.guesses?.find((guess): guess is ParsedTime => Boolean(guess)
      && guess!.timestamp <= readAt + CLOCK_SKEW_MS
      && (newer === undefined || guess!.timestamp <= newer)
      && (older === undefined || guess!.timestamp >= older)) ?? null;
  });
}

// Countries that keep one civil time. Spain and Portugal use their mainland
// zone (their islands differ by an hour). Countries spanning several zones
// (US, CA, BR, RU, AU, MX, ID...) are absent: they need a finer location.
// The rest of the list is every country or territory with a single zone in
// the IANA database, except those whose code a US state or Canadian province
// also uses (GA, PA, TN...) and Georgia, whose name a state has: "Atlanta, GA"
// and "Atlanta, Georgia" are in the US. CO, DE, IL, IN, MT, NL and SK keep
// town lists that tell the two apart (`regionHasTown`).
const COUNTRY_ZONES: Record<string, string> = {
  AT: 'Europe/Vienna', BE: 'Europe/Brussels', BG: 'Europe/Sofia', CH: 'Europe/Zurich',
  CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DE: 'Europe/Berlin', DK: 'Europe/Copenhagen',
  EE: 'Europe/Tallinn', ES: 'Europe/Madrid', FI: 'Europe/Helsinki', FR: 'Europe/Paris',
  GB: 'Europe/London', GR: 'Europe/Athens', HR: 'Europe/Zagreb', HU: 'Europe/Budapest',
  IE: 'Europe/Dublin', IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome', LI: 'Europe/Vaduz',
  LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga', MT: 'Europe/Malta',
  NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon',
  RO: 'Europe/Bucharest', SE: 'Europe/Stockholm', SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava',
  TR: 'Europe/Istanbul', AE: 'Asia/Dubai', IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata',
  UA: 'Europe/Kyiv', KW: 'Asia/Kuwait', SA: 'Asia/Riyadh', SV: 'America/El_Salvador',
  CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  MY: 'Asia/Kuala_Lumpur', PH: 'Asia/Manila', SG: 'Asia/Singapore', TH: 'Asia/Bangkok',
  TW: 'Asia/Taipei', VN: 'Asia/Ho_Chi_Minh',
  AD: 'Europe/Andorra', AF: 'Asia/Kabul', AG: 'America/Antigua', AI: 'America/Anguilla', AM: 'Asia/Yerevan', AO: 'Africa/Luanda',
  AW: 'America/Aruba', AX: 'Europe/Mariehamn', BA: 'Europe/Sarajevo', BB: 'America/Barbados', BD: 'Asia/Dhaka',
  BF: 'Africa/Ouagadougou', BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo', BL: 'America/St_Barthelemy',
  BM: 'Atlantic/Bermuda', BN: 'Asia/Brunei', BO: 'America/La_Paz', BQ: 'America/Kralendijk', BS: 'America/Nassau',
  BT: 'Asia/Thimphu', BW: 'Africa/Gaborone', BY: 'Europe/Minsk', BZ: 'America/Belize', CC: 'Indian/Cocos', CF: 'Africa/Bangui',
  CG: 'Africa/Brazzaville', CI: 'Africa/Abidjan', CK: 'Pacific/Rarotonga', CM: 'Africa/Douala', CO: 'America/Bogota', CR: 'America/Costa_Rica',
  CU: 'America/Havana', CV: 'Atlantic/Cape_Verde', CW: 'America/Curacao', CX: 'Indian/Christmas', DJ: 'Africa/Djibouti',
  DM: 'America/Dominica', DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers', EG: 'Africa/Cairo', EH: 'Africa/El_Aaiun',
  ER: 'Africa/Asmara', ET: 'Africa/Addis_Ababa', FJ: 'Pacific/Fiji', FK: 'Atlantic/Stanley', FO: 'Atlantic/Faroe',
  GD: 'America/Grenada', GF: 'America/Cayenne', GG: 'Europe/Guernsey', GH: 'Africa/Accra',
  GI: 'Europe/Gibraltar', GM: 'Africa/Banjul', GN: 'Africa/Conakry', GP: 'America/Guadeloupe', GQ: 'Africa/Malabo',
  GS: 'Atlantic/South_Georgia', GT: 'America/Guatemala', GW: 'Africa/Bissau', GY: 'America/Guyana', HN: 'America/Tegucigalpa',
  HT: 'America/Port-au-Prince', IM: 'Europe/Isle_of_Man', IO: 'Indian/Chagos', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran',
  JE: 'Europe/Jersey', JM: 'America/Jamaica', JO: 'Asia/Amman', KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh',
  KM: 'Indian/Comoro', KN: 'America/St_Kitts', KP: 'Asia/Pyongyang', LB: 'Asia/Beirut', LC: 'America/St_Lucia', LK: 'Asia/Colombo',
  LR: 'Africa/Monrovia', LS: 'Africa/Maseru', LY: 'Africa/Tripoli', MC: 'Europe/Monaco', MF: 'America/Marigot',
  MG: 'Indian/Antananarivo', MK: 'Europe/Skopje', ML: 'Africa/Bamako', MM: 'Asia/Yangon', MQ: 'America/Martinique',
  MR: 'Africa/Nouakchott', MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre', MZ: 'Africa/Maputo',
  NA: 'Africa/Windhoek', NF: 'Pacific/Norfolk', NG: 'Africa/Lagos', NI: 'America/Managua', NP: 'Asia/Kathmandu',
  NR: 'Pacific/Nauru', OM: 'Asia/Muscat', PK: 'Asia/Karachi', PM: 'America/Miquelon', PN: 'Pacific/Pitcairn', PW: 'Pacific/Palau',
  PY: 'America/Asuncion', QA: 'Asia/Qatar', RE: 'Indian/Reunion', RS: 'Europe/Belgrade', RW: 'Africa/Kigali',
  SB: 'Pacific/Guadalcanal', SH: 'Atlantic/St_Helena', SJ: 'Arctic/Longyearbyen', SL: 'Africa/Freetown', SM: 'Europe/San_Marino',
  SN: 'Africa/Dakar', SO: 'Africa/Mogadishu', SR: 'America/Paramaribo', SS: 'Africa/Juba', ST: 'Africa/Sao_Tome',
  SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane', TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena',
  TF: 'Indian/Kerguelen', TG: 'Africa/Lome', TJ: 'Asia/Dushanbe', TK: 'Pacific/Fakaofo', TL: 'Asia/Dili', TM: 'Asia/Ashgabat',
  TO: 'Pacific/Tongatapu', TT: 'America/Port_of_Spain', TV: 'Pacific/Funafuti', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala',
  UY: 'America/Montevideo', VC: 'America/St_Vincent', VE: 'America/Caracas', VG: 'America/Tortola', VU: 'Pacific/Efate',
  WF: 'Pacific/Wallis', WS: 'Pacific/Apia', YE: 'Asia/Aden', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare',
};
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
// Every region Intl names. Retired codes ("FX", "UK") repeat a current
// region's name and are left out.
const REGION_CODES = new Set(Array.from({ length: 26 * 26 }, (_, index) =>
  String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)))
  .filter((code) => ENGLISH_REGIONS.of(code) !== code && new Intl.Locale(`und-${code}`).region === code));
/** A name compared without case, accents or spacing differences. */
const regionKey = (name: string) =>
  name.normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase().replace(/[\u2019`]/g, "'").replace(/\s+/g, ' ').trim();
const REGION_BY_NAME = new Map<string, string>();
for (const language of ['en', 'de', 'fr', 'it', 'es', 'nl']) {
  const names = language === 'en' ? ENGLISH_REGIONS : new Intl.DisplayNames([language], { type: 'region' });
  for (const code of REGION_CODES) {
    const name = names.of(code)!;
    // German written without umlauts puts an e after the vowel: "Oesterreich".
    // English names Intl abbreviates are also written out: "Bosnia and
    // Herzegovina", "Saint Lucia".
    const spellings = language === 'de' ? [name, name.replace(/[äöüÄÖÜ]/g, (vowel) => `${vowel.normalize('NFD')[0]}e`)]
      : language === 'en' ? [name, name.replace(/ & /g, ' and ').replace(/^St\. /, 'Saint ')] : [name];
    for (const key of spellings.map(regionKey)) {
      // A name a large town shares names the town as often as the country.
      if (!REGION_BY_NAME.has(key) && (language === 'en' || !townName(key))) REGION_BY_NAME.set(key, code);
    }
  }
}
// Full, former or abbreviated names carriers print, which Intl writes otherwise: Cainiao names
// the United States "USA", and DHL's German scans name the United Kingdom "Großbritannien".
for (const [name, code] of [['United States of America', 'US'], ['USA', 'US'], ['Czech Republic', 'CZ'], ['Großbritannien', 'GB']] as const) {
  REGION_BY_NAME.set(regionKey(name), code);
}

/**
 * The ISO code of any country, whatever its clocks, from the code or its name
 * in English, German, French, Italian, Spanish or Dutch, without regard to
 * case or accents ("South Africa", "Südafrika" and "Afrique du Sud" are ZA);
 * null otherwise.
 */
export function countryCode(country: unknown): string | null {
  if (typeof country !== 'string') return null;
  const value = country.trim().toUpperCase();
  return REGION_CODES.has(value) ? value : REGION_BY_NAME.get(regionKey(value)) ?? null;
}

/** The zone of a single-zone country, from an ISO code or a name `countryCode` reads; null otherwise. */
export function countryTimeZone(country: unknown): string | null {
  const code = countryCode(country);
  return code && Object.hasOwn(COUNTRY_ZONES, code) ? COUNTRY_ZONES[code]! : null;
}

// A UPU office code (IMPC): two letters for its country, three for its place and one more.
const POSTAL_OFFICE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;

/**
 * The zone of a postal office named by its UPU office code ("GBLALA"), such as
 * an office of exchange: its country's, when the country keeps one civil time.
 * Scans the posts relay through the postal union carry the office's wall clock.
 * Spain's and Portugal's islands keep clocks of their own, so their offices
 * have none.
 */
export function postalOfficeZone(code: string): string | null {
  const country = POSTAL_OFFICE.exec(code)?.[1];
  return country && country !== 'ES' && country !== 'PT' ? countryTimeZone(country) : null;
}

/** The single-zone country keeping this civil time ("Europe/Zurich" is Switzerland's); null for UTC. */
export function timeZoneCountry(zone: string): string | null {
  const countries = Object.keys(COUNTRY_ZONES).filter((code) => COUNTRY_ZONES[code] === zone);
  return countries.length === 1 ? countries[0]! : null;
}

// US states and territories by postal code. A state with several zones keeps its
// majority zone.
const US_STATE_ZONES: Readonly<Record<string, string>> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico',
  GU: 'Pacific/Guam', VI: 'America/St_Thomas', AS: 'Pacific/Pago_Pago', MP: 'Pacific/Saipan',
};

/**
 * The zone of a US state or territory from its postal code ("IL"): its
 * majority zone when it has several; null otherwise.
 */
export function usStateTimeZone(state: unknown): string | null {
  if (typeof state !== 'string') return null;
  const code = state.trim().toUpperCase();
  return Object.hasOwn(US_STATE_ZONES, code) ? US_STATE_ZONES[code]! : null;
}

/**
 * Whether a country's clocks show a UTC offset ("+08:00") in winter or summer:
 * the United States' by its states' zones, another country's by its one zone.
 * Null for an offset it cannot read or a country on several clocks it does not know.
 */
export function countryKeepsOffset(country: unknown, offset: string): boolean | null {
  const code = countryCode(country);
  const zones = code === 'US' ? [...new Set(Object.values(US_STATE_ZONES))]
    : code && Object.hasOwn(COUNTRY_ZONES, code) ? [COUNTRY_ZONES[code]!] : [];
  const parts = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!zones.length || !parts) return null;
  const minutes = (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 60 + Number(parts[3]));
  const { year } = DateTime.utc();
  return zones.some((zone) => [1, 7].some((month) => DateTime.fromObject({ year, month, day: 1 }, { zone }).offset === minutes));
}

// Three-digit ZIP prefixes by state, from the Census Bureau's 2020 ZCTA-to-county file: each
// prefix goes to the state holding most of its ZCTAs. A prefix without ZCTAs, a post office box
// or single-company one, is filled only inside one state's run. 055 (Massachusetts) and 733
// (Texas) sit inside Vermont's and Oklahoma's runs, and the military prefixes have no state.
const US_ZIP_PREFIXES: ReadonlyArray<readonly [number, number, string]> = [
  [6, 7, 'PR'], [8, 8, 'VI'], [9, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'],
  [39, 49, 'ME'], [50, 54, 'VT'], [56, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'],
  [150, 196, 'PA'], [197, 199, 'DE'], [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'],
  [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'],
  [300, 319, 'GA'], [320, 339, 'FL'], [341, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
  [386, 397, 'MS'], [398, 398, 'GA'], [400, 427, 'KY'], [430, 458, 'OH'], [460, 479, 'IN'],
  [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'],
  [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'],
  [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 732, 'OK'], [734, 749, 'OK'],
  [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [890, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
  [969, 969, 'GU'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

/** The state or territory of a five-digit ZIP code ("94103", "94103-1234"), by its prefix; null otherwise. */
export function usZipState(zip: unknown): string | null {
  const match = typeof zip === 'string' ? /^\s*(\d{3})\d{2}(?:-\d{4})?\s*$/.exec(zip) : null;
  if (!match) return null;
  const prefix = Number(match[1]);
  return US_ZIP_PREFIXES.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

// Canadian provinces and territories by postal code, each in its majority zone.
const CANADA_PROVINCE_ZONES: Readonly<Record<string, string>> = {
  AB: 'America/Edmonton', BC: 'America/Vancouver', MB: 'America/Winnipeg', NB: 'America/Moncton',
  NL: 'America/St_Johns', NS: 'America/Halifax', NT: 'America/Edmonton', NU: 'America/Iqaluit',
  ON: 'America/Toronto', PE: 'America/Halifax', QC: 'America/Toronto', SK: 'America/Regina',
  YT: 'America/Whitehorse',
};

/** The zone of a Canadian province or territory from its postal code ("ON"): its majority zone; null otherwise. */
export function canadaProvinceTimeZone(province: unknown): string | null {
  if (typeof province !== 'string') return null;
  const code = province.trim().toUpperCase();
  return Object.hasOwn(CANADA_PROVINCE_ZONES, code) ? CANADA_PROVINCE_ZONES[code]! : null;
}

/** A town name as the region town lists key it: "St. John's" and "SAINT JOHNS" are both "stjohns". */
export function townKey(name: string): string {
  return name.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
    .replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste').replace(/\bmount\b/g, 'mt').replace(/\bfort\b/g, 'ft')
    .replace(/[^a-z0-9]/g, '');
}

const REGION_TOWN_SETS = new Map(Object.entries(REGION_TOWNS).map(([code, towns]) => [code, new Set(towns.split('|'))]));

/**
 * Whether a town of this name lies in the US state or Canadian province whose
 * code also names a single-clock country: Chicago is in Illinois, not Israel,
 * and Koeln is not in Delaware. Also whether it lies in an island group that
 * keeps another clock than its country, by ISO 3166-2 code: the Canary Islands
 * (`ES-CN`) and the Azores (`PT-20`), without the names their mainland also
 * has. Only CO, DE, IL, IN, MT, NL, SK and these two have town lists (generated
 * from GeoNames); false for any other code.
 */
export function regionHasTown(code: string, town: string): boolean {
  return REGION_TOWN_SETS.get(code.trim().toUpperCase())?.has(townKey(town)) ?? false;
}

/** Epoch milliseconds (numbers or numeric strings); zero and negatives are rejected. */
export function epochMillisTime(value: unknown): ParsedTime | null {
  const millis = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return fromDateTime(DateTime.fromMillis(millis, { zone: 'utc' }));
}

/** Epoch seconds, same rules as `epochMillisTime`. */
export function epochSecondsTime(value: unknown): ParsedTime | null {
  const seconds = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return epochMillisTime(seconds * 1000);
}

/** A local calendar day as `YYYY-MM-DD`, validated; never a timestamp. */
export function calendarDay(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger)) return null;
  const parsed = DateTime.fromObject({ year, month, day }, { zone: 'utc' });
  return parsed.isValid ? parsed.toISODate() : null;
}
