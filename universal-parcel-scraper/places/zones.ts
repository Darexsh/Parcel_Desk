/**
 * The clocks `countryTimeZone` (core/time) leaves out: countries whose code is
 * also a US state's or a Swiss canton's, and countries keeping several zones,
 * each zone with its principal place, from the tz database's zone.tab. Spain
 * and Portugal are here too, for the Canaries and the Azores.
 */
import { canadaProvinceTimeZone, countryTimeZone, usStateTimeZone } from '../core/time/index.js';

const SINGLE_CLOCKS: Readonly<Record<string, string>> = {
  AL: 'Europe/Tirane', AS: 'Pacific/Pago_Pago', AZ: 'Asia/Baku', GA: 'Africa/Libreville', GE: 'Asia/Tbilisi',
  GU: 'Pacific/Guam', KY: 'America/Cayman', LA: 'Asia/Vientiane', MA: 'Africa/Casablanca',
  MD: 'Europe/Chisinau', ME: 'Europe/Podgorica', MO: 'Asia/Macau', MP: 'Pacific/Saipan',
  MS: 'America/Montserrat', NC: 'Pacific/Noumea', NE: 'Africa/Niamey', NU: 'Pacific/Niue',
  PA: 'America/Panama', PE: 'America/Lima', PR: 'America/Puerto_Rico', SC: 'Indian/Mahe',
  SD: 'Africa/Khartoum', TN: 'Africa/Tunis', VA: 'Europe/Vatican', VI: 'America/St_Thomas',
  YT: 'Indian/Mayotte',
};

type Clock = readonly [zone: string, latitude: number, longitude: number];

const COUNTRY_CLOCKS: Readonly<Record<string, readonly Clock[]>> = {
  AR: [['America/Argentina/Buenos_Aires', -34.6, -58.5], ['America/Argentina/Cordoba', -31.4, -64.2],
    ['America/Argentina/Salta', -24.8, -65.4], ['America/Argentina/Jujuy', -24.2, -65.3],
    ['America/Argentina/Tucuman', -26.8, -65.2], ['America/Argentina/Catamarca', -28.5, -65.8],
    ['America/Argentina/La_Rioja', -29.4, -66.8], ['America/Argentina/San_Juan', -31.5, -68.5],
    ['America/Argentina/Mendoza', -32.9, -68.8], ['America/Argentina/San_Luis', -33.3, -66.3],
    ['America/Argentina/Rio_Gallegos', -51.6, -69.2], ['America/Argentina/Ushuaia', -54.8, -68.3]],
  AU: [['Australia/Lord_Howe', -31.6, 159.1], ['Antarctica/Macquarie', -54.5, 158.9],
    ['Australia/Hobart', -42.9, 147.3], ['Australia/Melbourne', -37.8, 145], ['Australia/Sydney', -33.9, 151.2],
    ['Australia/Broken_Hill', -31.9, 141.4], ['Australia/Brisbane', -27.5, 153],
    ['Australia/Lindeman', -20.3, 149], ['Australia/Adelaide', -34.9, 138.6], ['Australia/Darwin', -12.5, 130.8],
    ['Australia/Perth', -31.9, 115.8], ['Australia/Eucla', -31.7, 128.9]],
  BR: [['America/Noronha', -3.9, -32.4], ['America/Belem', -1.4, -48.5], ['America/Fortaleza', -3.7, -38.5],
    ['America/Recife', -8.1, -34.9], ['America/Araguaina', -7.2, -48.2], ['America/Maceio', -9.7, -35.7],
    ['America/Bahia', -13, -38.5], ['America/Sao_Paulo', -23.5, -46.6], ['America/Campo_Grande', -20.4, -54.6],
    ['America/Cuiaba', -15.6, -56.1], ['America/Santarem', -2.4, -54.9], ['America/Porto_Velho', -8.8, -63.9],
    ['America/Boa_Vista', 2.8, -60.7], ['America/Manaus', -3.1, -60], ['America/Eirunepe', -6.7, -69.9],
    ['America/Rio_Branco', -10, -67.8]],
  CA: [['America/St_Johns', 47.6, -52.7], ['America/Halifax', 44.6, -63.6], ['America/Glace_Bay', 46.2, -60],
    ['America/Moncton', 46.1, -64.8], ['America/Goose_Bay', 53.3, -60.4], ['America/Blanc-Sablon', 51.4, -57.1],
    ['America/Toronto', 43.6, -79.4], ['America/Iqaluit', 63.7, -68.5], ['America/Atikokan', 48.8, -91.6],
    ['America/Winnipeg', 49.9, -97.2], ['America/Resolute', 74.7, -94.8], ['America/Rankin_Inlet', 62.8, -92.1],
    ['America/Regina', 50.4, -104.7], ['America/Swift_Current', 50.3, -107.8], ['America/Edmonton', 53.5, -113.5],
    ['America/Cambridge_Bay', 69.1, -105.1], ['America/Inuvik', 68.3, -133.7], ['America/Vancouver', 49.3, -123.1],
    ['America/Creston', 49.1, -116.5], ['America/Dawson_Creek', 55.8, -120.2],
    ['America/Fort_Nelson', 58.8, -122.7], ['America/Whitehorse', 60.7, -135.1], ['America/Dawson', 64.1, -139.4]],
  CD: [['Africa/Kinshasa', -4.3, 15.3], ['Africa/Lubumbashi', -11.7, 27.5]],
  CL: [['America/Santiago', -33.5, -70.7], ['America/Coyhaique', -45.6, -72.1],
    ['America/Punta_Arenas', -53.1, -70.9], ['Pacific/Easter', -27.1, -109.4]],
  EC: [['America/Guayaquil', -2.2, -79.8], ['Pacific/Galapagos', -0.9, -89.6]],
  ES: [['Europe/Madrid', 40.4, -3.7], ['Atlantic/Canary', 28.1, -15.4]],
  FM: [['Pacific/Chuuk', 7.4, 151.8], ['Pacific/Pohnpei', 7, 158.2], ['Pacific/Kosrae', 5.3, 163]],
  GL: [['America/Nuuk', 64.2, -51.7], ['America/Danmarkshavn', 76.8, -18.7], ['America/Scoresbysund', 70.5, -22],
    ['America/Thule', 76.6, -68.8]],
  ID: [['Asia/Jakarta', -6.2, 106.8], ['Asia/Pontianak', 0, 109.3], ['Asia/Makassar', -5.1, 119.4],
    ['Asia/Jayapura', -2.5, 140.7]],
  KI: [['Pacific/Tarawa', 1.4, 173], ['Pacific/Kanton', -2.8, -171.7], ['Pacific/Kiritimati', 1.9, -157.3]],
  KZ: [['Asia/Almaty', 43.2, 77], ['Asia/Qyzylorda', 44.8, 65.5], ['Asia/Qostanay', 53.2, 63.6],
    ['Asia/Aqtobe', 50.3, 57.2], ['Asia/Aqtau', 44.5, 50.3], ['Asia/Atyrau', 47.1, 51.9], ['Asia/Oral', 51.2, 51.4]],
  MH: [['Pacific/Majuro', 7.2, 171.2], ['Pacific/Kwajalein', 9.1, 167.3]],
  MN: [['Asia/Ulaanbaatar', 47.9, 106.9], ['Asia/Hovd', 48, 91.7]],
  MX: [['America/Mexico_City', 19.4, -99.2], ['America/Cancun', 21.1, -86.8], ['America/Merida', 21, -89.6],
    ['America/Monterrey', 25.7, -100.3], ['America/Matamoros', 25.8, -97.5], ['America/Chihuahua', 28.6, -106.1],
    ['America/Ciudad_Juarez', 31.7, -106.5], ['America/Ojinaga', 29.6, -104.4], ['America/Mazatlan', 23.2, -106.4],
    ['America/Bahia_Banderas', 20.8, -105.2], ['America/Hermosillo', 29.1, -111], ['America/Tijuana', 32.5, -117]],
  NZ: [['Pacific/Auckland', -36.9, 174.8], ['Pacific/Chatham', -44, -176.6]],
  PF: [['Pacific/Tahiti', -17.5, -149.6], ['Pacific/Marquesas', -9, -139.5], ['Pacific/Gambier', -23.1, -134.9]],
  PG: [['Pacific/Port_Moresby', -9.5, 147.2], ['Pacific/Bougainville', -6.2, 155.6]],
  PS: [['Asia/Gaza', 31.5, 34.5], ['Asia/Hebron', 31.5, 35.1]],
  PT: [['Europe/Lisbon', 38.7, -9.1], ['Atlantic/Madeira', 32.6, -16.9], ['Atlantic/Azores', 37.7, -25.7]],
  RU: [['Europe/Kaliningrad', 54.7, 20.5], ['Europe/Moscow', 55.8, 37.6], ['Europe/Kirov', 58.6, 49.6],
    ['Europe/Volgograd', 48.7, 44.4], ['Europe/Astrakhan', 46.4, 48], ['Europe/Saratov', 51.6, 46],
    ['Europe/Ulyanovsk', 54.3, 48.4], ['Europe/Samara', 53.2, 50.1], ['Asia/Yekaterinburg', 56.9, 60.6],
    ['Asia/Omsk', 55, 73.4], ['Asia/Novosibirsk', 55, 82.9], ['Asia/Barnaul', 53.4, 83.8],
    ['Asia/Tomsk', 56.5, 85], ['Asia/Novokuznetsk', 53.8, 87.1], ['Asia/Krasnoyarsk', 56, 92.8],
    ['Asia/Irkutsk', 52.3, 104.3], ['Asia/Chita', 52, 113.5], ['Asia/Yakutsk', 62, 129.7],
    ['Asia/Khandyga', 62.7, 135.6], ['Asia/Vladivostok', 43.2, 131.9], ['Asia/Ust-Nera', 64.6, 143.2],
    ['Asia/Magadan', 59.6, 150.8], ['Asia/Sakhalin', 47, 142.7], ['Asia/Srednekolymsk', 67.5, 153.7],
    ['Asia/Kamchatka', 53, 158.7], ['Asia/Anadyr', 64.8, 177.5]],
  US: [['America/New_York', 40.7, -74], ['America/Detroit', 42.3, -83],
    ['America/Kentucky/Louisville', 38.3, -85.8], ['America/Kentucky/Monticello', 36.8, -84.8],
    ['America/Indiana/Indianapolis', 39.8, -86.2], ['America/Indiana/Vincennes', 38.7, -87.5],
    ['America/Indiana/Winamac', 41.1, -86.6], ['America/Indiana/Marengo', 38.4, -86.3],
    ['America/Indiana/Petersburg', 38.5, -87.3], ['America/Indiana/Vevay', 38.7, -85.1],
    ['America/Chicago', 41.9, -87.7], ['America/Indiana/Tell_City', 38, -86.8],
    ['America/Indiana/Knox', 41.3, -86.6], ['America/Menominee', 45.1, -87.6],
    ['America/North_Dakota/Center', 47.1, -101.3], ['America/North_Dakota/New_Salem', 46.8, -101.4],
    ['America/North_Dakota/Beulah', 47.3, -101.8], ['America/Denver', 39.7, -105], ['America/Boise', 43.6, -116.2],
    ['America/Phoenix', 33.4, -112.1], ['America/Los_Angeles', 34.1, -118.2], ['America/Anchorage', 61.2, -149.9],
    ['America/Juneau', 58.3, -134.4], ['America/Sitka', 57.2, -135.3], ['America/Metlakatla', 55.1, -131.6],
    ['America/Yakutat', 59.5, -139.7], ['America/Nome', 64.5, -165.4], ['America/Adak', 51.9, -176.7],
    ['Pacific/Honolulu', 21.3, -157.9]],
  UZ: [['Asia/Samarkand', 39.7, 66.8], ['Asia/Tashkent', 41.3, 69.3]],};

/** The zone most of a country's people live on, for a scan that names only the country. */
const MAIN_CLOCKS: Readonly<Record<string, string>> = {
  AR: 'America/Argentina/Buenos_Aires', AU: 'Australia/Sydney', BR: 'America/Sao_Paulo', CA: 'America/Toronto',
  CD: 'Africa/Kinshasa', CL: 'America/Santiago', EC: 'America/Guayaquil', ES: 'Europe/Madrid', FM: 'Pacific/Pohnpei',
  GL: 'America/Nuuk', ID: 'Asia/Jakarta', KI: 'Pacific/Tarawa', KZ: 'Asia/Almaty', MH: 'Pacific/Majuro',
  MN: 'Asia/Ulaanbaatar', MX: 'America/Mexico_City', NZ: 'Pacific/Auckland', PF: 'Pacific/Tahiti',
  PG: 'Pacific/Port_Moresby', PS: 'Asia/Hebron', PT: 'Europe/Lisbon', RU: 'Europe/Moscow', US: 'America/New_York',
  UZ: 'Asia/Tashkent',
};

// Australian states and territories by postal code. Broken Hill keeps Adelaide's clock in New South Wales.
const AUSTRALIA_STATE_ZONES: Readonly<Record<string, string>> = {
  ACT: 'Australia/Sydney', NSW: 'Australia/Sydney', NT: 'Australia/Darwin', QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide', TAS: 'Australia/Hobart', VIC: 'Australia/Melbourne', WA: 'Australia/Perth',
};

// Brazilian states by postal code, each on its majority zone.
const BRAZIL_STATE_ZONES: Readonly<Record<string, string>> = {
  AC: 'America/Rio_Branco', AM: 'America/Manaus', RO: 'America/Porto_Velho', RR: 'America/Boa_Vista',
  MT: 'America/Cuiaba', MS: 'America/Campo_Grande', PA: 'America/Belem', AP: 'America/Belem', TO: 'America/Araguaina',
  MA: 'America/Fortaleza', PI: 'America/Fortaleza', CE: 'America/Fortaleza', RN: 'America/Fortaleza',
  PB: 'America/Fortaleza', PE: 'America/Recife', AL: 'America/Maceio', SE: 'America/Maceio', BA: 'America/Bahia',
  DF: 'America/Sao_Paulo', ES: 'America/Sao_Paulo', GO: 'America/Sao_Paulo', MG: 'America/Sao_Paulo',
  PR: 'America/Sao_Paulo', RJ: 'America/Sao_Paulo', RS: 'America/Sao_Paulo', SC: 'America/Sao_Paulo',
  SP: 'America/Sao_Paulo',
};

/** The zone of a state or province, by country and postal code, where a country has several. */
export function regionZone(country: string, region: string): string | null {
  if (country === 'US') return usStateTimeZone(region);
  if (country === 'CA') return canadaProvinceTimeZone(region);
  if (country === 'AU') return AUSTRALIA_STATE_ZONES[region] ?? null;
  if (country === 'BR') return BRAZIL_STATE_ZONES[region] ?? null;
  return null;
}

// States and provinces part of which keeps another clock than the one most of their people do.
const SPLIT_REGIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  US: {
    AK: ['America/Adak'], AZ: ['America/Denver'], FL: ['America/Chicago'], ID: ['America/Los_Angeles'],
    IN: ['America/Chicago'], KS: ['America/Denver'], KY: ['America/Chicago'], MI: ['America/Chicago'],
    ND: ['America/Denver'], NE: ['America/Denver'], OR: ['America/Boise'], SD: ['America/Denver'],
    TN: ['America/New_York'], TX: ['America/Denver'],
  },
  CA: {
    BC: ['America/Edmonton', 'America/Creston'], NL: ['America/Goose_Bay'], NU: ['America/Winnipeg', 'America/Edmonton'],
    ON: ['America/Winnipeg'], QC: ['America/Halifax', 'America/Blanc-Sablon'], SK: ['America/Edmonton'],
  },
  AU: { NSW: ['Australia/Broken_Hill'] },
  BR: { AM: ['America/Rio_Branco'] },
};

// Florida's line between Eastern and Central time (49 CFR 71.5(f)): down the Apalachicola River from
// Jim Woodruff Dam, then west along the Intracoastal Waterway to Gulf County's west line, whose
// south keeps Eastern. The river by latitude and the waterway by longitude, north to south and east to west.
const APALACHICOLA_RIVER = [[30.71, -84.87], [30.44, -85.02], [30.1, -85.07], [29.95, -85.02], [29.78, -85]] as const;
const GULF_WATERWAY = [[-85, 29.78], [-85.22, 29.88], [-85.39, 30.03]] as const;
const GULF_COUNTY_WEST = -85.39;

/** The second value of a line at the first, between its points; beyond its ends, the nearest end's. */
function along(line: readonly (readonly [number, number])[], at: number): number {
  const descending = line[0]![0] > line[line.length - 1]![0];
  const index = line.findIndex(([key]) => (descending ? key <= at : key >= at));
  if (index <= 0) return index === 0 ? line[0]![1] : line[line.length - 1]![1];
  const [[fromKey, fromValue], [toKey, toValue]] = [line[index - 1]!, line[index]!];
  return fromValue + (toValue - fromValue) * (at - fromKey) / (toKey - fromKey);
}

/**
 * The zone of a point in a state split between zones, where its place decides: Florida's
 * Panhandle keeps Central time. Null where the state's main zone holds.
 */
export function splitRegionZone(country: string, region: string, latitude: number, longitude: number): string | null {
  if (country !== 'US' || region !== 'FL') return null;
  const central = longitude < GULF_COUNTY_WEST
    || (longitude < along(APALACHICOLA_RIVER, latitude) && latitude > along(GULF_WATERWAY, longitude));
  return central ? 'America/Chicago' : null;
}

/** The clocks of a state or province besides its main one, where part of it keeps another. */
export function otherRegionZones(country: string, region: string): readonly string[] {
  return SPLIT_REGIONS[country]?.[region] ?? [];
}

/** Whether a country keeps several zones, among which a scan's place must choose. */
export function hasSeveralClocks(country: string): boolean {
  return Object.hasOwn(COUNTRY_CLOCKS, country);
}

/** Whether a country keeps this zone, as its one clock or as one of its several. */
export function keepsZone(country: string, zone: string): boolean {
  const clocks = COUNTRY_CLOCKS[country];
  return clocks ? clocks.some(([clock]) => clock === zone) : (SINGLE_CLOCKS[country] ?? countryTimeZone(country)) === zone;
}

/** The zones a country keeps: its one clock or each of its several; none for an unknown code. */
export function countryZones(country: string): readonly string[] {
  const clocks = COUNTRY_CLOCKS[country];
  if (clocks) return clocks.map(([zone]) => zone);
  const zone = SINGLE_CLOCKS[country] ?? countryTimeZone(country);
  return zone ? [zone] : [];
}

/** The zone of a country that keeps one, or the one most of its people live on; null for an unknown code. */
export function mainZone(country: string): string | null {
  return MAIN_CLOCKS[country] ?? SINGLE_CLOCKS[country] ?? countryTimeZone(country);
}

/**
 * The zone of a point in a country: the country's one zone, else the zone whose
 * principal place lies nearest. Near a border between zones that can be the
 * neighbour's; `placeTimeZone` asks the region first where the zones follow states.
 */
export function pointZone(country: string, latitude: number, longitude: number): string | null {
  const clocks = COUNTRY_CLOCKS[country];
  if (!clocks) return SINGLE_CLOCKS[country] ?? countryTimeZone(country);
  let nearest: Clock = clocks[0]!;
  let best = Infinity;
  for (const clock of clocks) {
    // Degrees of longitude shrink towards the poles; this is enough to rank a few places.
    const distance = (clock[1] - latitude) ** 2 + ((clock[2] - longitude) * Math.cos(latitude * Math.PI / 180)) ** 2;
    if (distance < best) [nearest, best] = [clock, distance];
  }
  return nearest[0];
}
