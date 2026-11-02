
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { DateTime } from 'luxon';
import { CARRIER_DEFINITIONS } from '../core/catalog/definitions.js';
import type { CarrierResult } from '../core/result/index.js';
import { countryCode, timeZoneCountry } from '../core/time/index.js';
import { ambiguousAddressCodes, militaryPostOffice, trackingPlace } from './trackingLocation.js';
import facilityList from './facilities.json' with { type: 'json' };
import hubList from './hubs.json' with { type: 'json' };
import { nameKey, nameKeys } from './names.mjs';
import { mainZone, otherRegionZones, pointZone, regionZone, splitRegionZone } from './zones.js';

export { carrierHomeZone, dateLocalClocks, type ZoneBasis } from './clocks.js';

/** Where a scan happened, as precisely as its free-text location allows. */
export interface EventPlace {
  latitude: number;
  longitude: number;
  precision: 'city' | 'country';
  /** ISO 3166-1 alpha-2. */
  country: string;
  name: string;
  /** The facility name, when distinct from the town. */
  site?: string;
  /** The state or province of a place that is its country's, by the code carriers print ("WA"), when the scan names one. */
  region?: string;
}

/** Where a carrier itself puts a scan's facility (`point` on a stored scan). */
export interface EventPoint {
  latitude: number;
  longitude: number;
}

export interface PlaceHints {
  /** Countries the parcel is likely in, strongest first: neighbouring scans, destination, carrier. */
  countries?: readonly string[];
  /** The parcel's carriers, by catalog id: a hub of their own is known by the name they give it. */
  carriers?: readonly string[];
}

interface Airport { code: string; country: string; latitude: number; longitude: number; name: string; town: string }
interface Region { country: string; admin1: string }

interface Gazetteer {
  names: string[];
  /** Country, admin1 and admin2 as indices into `codes`: most of 230,000 places share a few thousand codes. */
  codes: string[];
  country: Uint16Array;
  admin1: Uint16Array;
  admin2: Uint16Array;
  latitude: Float32Array;
  longitude: Float32Array;
  /** In thousands. Postal localities without a census count are 0. */
  population: Uint32Array;
  /** Place indices; alternate names (exonyms, translations) are stored as ~index. */
  keys: Map<string, number | number[]>;
  postcodes: Map<string, { latitude: number; longitude: number }>;
  countries: Map<string, { name: string; latitude: number; longitude: number }>;
  /** First-level regions by name: "ontario" is CA 08. */
  regions: Map<string, Region[]>;
  /** The names of each region, by country and code: "BG.42" is "sofia capital". */
  regionNames: Map<string, string[]>;
  /** Airports with scheduled flights, by IATA code. */
  airports: Map<string, Airport>;
  /** The places of each country, filled when first asked for. */
  byCountry: Map<string, number[]>;
  /** Airports by the words of their names that are neither generic nor their town's ("o hare"), filled when first asked for. */
  airportNames: Map<string, Airport[]>;
}

const DATA = new URL('./places.tsv.br', import.meta.url);
const PINCODES = new URL('./pincodes.json', import.meta.url);
const ZIPCODES = new URL('./zipcodes.json', import.meta.url);
// Words for facilities and services rather than places ("Agence DPD de La Crau", "PAKETZENTRUM", "ISC NEW YORK NY(USPS)").
const FACILITY_WORDS = new Set(`
  agence agency air airport area branch bureau cedex cidex center centre centro centrum clasificacion colis
  customs delivery depot deposito destination distribution distribuicao dogana douane export facility filiale
  gateway hub import international intl livraison local location logistics logistik mail oddzial office oficina
  operations operativo origin paketzentrum briefzentrum verteilzentrum sortierzentrum zustellbasis zustellstelle
  parcel parcels plateforme platform point postal postfiliale postfach poste pz bz return service services site
  smistamento sort sorter sorting station terminal tratamento tri unidade ufficio warehouse zentrum zoll zollamt
  dhl ups fedex gls dpd tnt usps colissimo chronopost postnl bpost evri hermes cainiao yanwen parcelforce posti
  planzer quickpac amazon express post home house address recipient sender neighbourhood neighborhood unknown
  courrier courier exchange foreign network processing transit worldwide isc ndc idc piac pic pfc ppdc cdis ctc
  gpo nsh rms tmo fpo aeroport aeroporto aeropuerto flughafen luchthaven lufthavn flygplats lentoasema lotnisko
`.trim().split(/\s+/));
// Chinese words for a facility or a part of a town, not a town: "中心扫描" is a centre's scan, not
// Zhongxin in Yunnan, and a "新城" is a town's new district.
const CJK_FACILITY_WORDS = new Set(['中心', '新城']);
// Administrative words a town can be written with or without ("Jinhua City", "Guangdong Sheng").
const DIVISION_WORDS = new Set('city province prefecture district county shi sheng qu xian si gu do ku ken'.split(' '));
// Words that say a scan happened at an airport ("Frankfurt Airport (FRA)", "HELSINKI-VANTAAN LENTOASEMA").
const AIRPORT_WORDS = new Set('airport aeroport aeroporto aeropuerto flughafen luchthaven lufthavn flygplats lentoasema lotnisko'.split(' '));
// Words of airport names that do not tell one airport from another.
const AIRPORT_NAME_WORDS = new Set(`
  airport international intl regional municipal national field airfield aerodrome air base the de del la le du of and
  city county metropolitan
`.trim().split(/\s+/));
// Region names too vague to place a scan in their country on their own.
const VAGUE_REGIONS = new Set('central capital north south east west centre center islands national federal'.split(' '));
const LEADING_WORDS = new Set(['de', 'du', 'des', 'di', 'da', 'del', 'della', 'von', 'of']);
// Articles, which go with a facility word they come before: "EL AEROPUERTO DEL PRAT" is the airport of El Prat.
const ARTICLES = new Set(['el', 'la', 'l', 'le', 'les', 'los', 'las', 'il', 'lo', 'the']);
// Words that join a town's name to the river, region or city it is told apart by: "Weil am Rhein",
// "Bernau bei Berlin", "Boulogne-sur-Mer", "Ústí nad Labem".
const LINKING_WORDS = new Set(['am', 'im', 'der', 'bei', 'upon', 'sur', 'nad', 'pod']);
// The words a letter and its full stop stand for in "Frankfurt a.d. Oder", "Weil a. Rhein", "Bernau b.
// Berlin" or "Ústí n. Labem": "a." is "am" or "an".
const ABBREVIATED_LINKS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  a: [['am'], ['an']], 'a d': [['an', 'der']], b: [['bei']], i: [['im'], ['in']], 'i d': [['in', 'der']],
  n: [['nad']], o: [['ob']], 'o d': [['ob', 'der']], p: [['pod']],
};
// The words a town's full name can put before what brackets after its name hold: "Neustadt (Holstein)"
// is Neustadt in Holstein, "Neustadt (Weinstrasse)" Neustadt an der Weinstraße.
const QUALIFIER_LINKS = ['in', 'an der', 'am', 'an', 'im', 'in der', 'bei', 'ob der', 'nad', 'pod', 'sur', 'upon'];
// Carriers print provinces the way the post does; GeoNames numbers them.
const ADMIN_CODES: Record<string, Record<string, string>> = {
  CA: { AB: '01', BC: '02', MB: '03', NB: '04', NL: '05', NS: '07', ON: '08', PE: '09', QC: '10', SK: '11', YT: '12', NT: '13', NU: '14' },
  AU: { ACT: '01', NSW: '02', NT: '03', QLD: '04', SA: '05', TAS: '06', VIC: '07', WA: '08' },
  BR: {
    AC: '01', AL: '02', AP: '03', AM: '04', BA: '05', CE: '06', DF: '07', ES: '08', MS: '11', MA: '13', MT: '14', MG: '15',
    PA: '16', PB: '17', PR: '18', PI: '20', RJ: '21', RN: '22', RS: '23', RO: '24', RR: '25', SC: '26', SP: '27', SE: '28',
    GO: '29', PE: '30', TO: '31',
  },
};
// A place nothing else confirms has to be a known town, not a hamlet with the same name.
const UNCONFIRMED_MIN_THOUSANDS = 15;
// A carrier's own point for a scan has to agree with the town its text names.
const POINT_MAX_KM = 30;
// An airport a scan names has to be this close to the town it names,
const AIRPORT_MAX_KM = 60;
// or this close when the scan names it whole with a word that says it is one: Narita is Tokyo's.
const NAMED_AIRPORT_MAX_KM = 150;
// A hub's name ranks like a town of this many thousand people.
const HUB_THOUSANDS = 50;
// A carrier that delivers in more countries than this is at home in none of them.
const HOME_COUNTRIES_MAX = 6;
// A town only its name places is a namesake when it takes the parcel this far off its way,
const DETOUR_MAX_KM = 6000;
// or, where the scans stop, when it is this far from them and from the parcel's countries.
const LEAP_MAX_KM = 3000;
// There, a city of this many thousand people is known wherever it is written.
const WORLD_CITY_THOUSANDS = 1000;
/** The city a region is named after ("Santo Domingo Province") has at least this many thousand people. */
const NAMESAKE_THOUSANDS = 100;
// A town this near a longer place name that contains its name may be the one that name means.
const PART_OF_NAME_KM = 50;
// The most words of a town's name looked up between other words.
const MIDDLE_WORDS = 3;
// Towns of one name in one country whose scores are this close (twice the people at most) are told apart by the scans around them.
const TWIN_SCORE = Math.log10(2);
// A town of that size this many times larger than its namesake in a country the parcel is in keeps its name.
const DOMINANT_TIMES = 10;
// Scans that record paperwork, which an office can file where the parcel is not.
const PAPERWORK_STAGES = new Set(['registered', 'pending', 'customs']);
// Of those, the scans that register the parcel.
const REGISTRATION_STAGES = new Set(['registered', 'pending']);
// Such a scan in a town this far off the way between the parcel's handling scans was filed elsewhere.
const AWAY_DETOUR_KM = 300;
// No parcel travels faster than a plane, and two hours absorb a scan clock's rounding and delays.
const PLANE_KMH = 1000;
const CLOCK_SLACK_HOURS = 2;
// A county-level city lies this close to the city of its prefecture.
const COUNTY_MAX_KM = 150;
// A town a carrier names after the city it serves is this close to it.
const SUBURB_MAX_KM = 30;
// One the carrier tells apart by a city in brackets, this close: "Cloppenburg (Oldenburg)".
const BRACKETED_MAX_KM = 100;
// An airport only its bare code names is on the parcel's way when it takes it no further off than this:
// a hub such as Doha between China and Europe.
const AIRPORT_DETOUR_KM = 3000;

// Swiss Post scans end in the site's six-digit number: "Zürich Briefzentrum 801050".
const FACILITIES = new Map(facilityList.map((facility) => [`${facility.country}:${facility.code}`, facility]));
interface Hub {
  country: string;
  names: string[];
  /** Absent for a carrier's site named after the country it serves, which places a scan in that country alone. */
  town?: string;
  /** The state, province or canton, where carriers write one after the town. */
  admin1?: string;
  /** The facility's own name, when the carrier's words are not the town's. */
  site?: string;
  airport?: string;
  latitude?: number;
  longitude?: number;
  /** The carriers whose hub this is; any carrier's when absent. */
  carriers?: string[];
}
// Names carriers give a hub instead of its town ("ROISSY" is Paris-Charles de Gaulle, not
// Roissy-en-Brie), and hubs the gazetteer cannot place by name ("SEKOCIN STARY", "Fenggang Town", "TERRASSON").
const HUBS = new Map<string, Hub[]>();
for (const hub of hubList as Hub[]) for (const name of hub.names) HUBS.set(nameKey(name), [...HUBS.get(nameKey(name)) ?? [], hub]);

let loaded: Gazetteer | null = null;

/** Indian PIN codes by town: runs of PINs `[first, last, town]`, in order, and the towns. */
interface Pincodes { towns: [string, number, number][]; ranges: [number, number, number][] }
let pincodes: Pincodes | null = null;
/** US ZIP Code prefixes by the town most of their codes are in: `[town, state, latitude, longitude]`. */
let zipPrefixes: Record<string, [string, string, number, number]> | null = null;

function gazetteer(): Gazetteer {
  if (loaded) return loaded;
  // Parsed straight from bytes: substrings of one decompressed string would keep all 10 MB of it alive.
  const bytes = brotliDecompressSync(readFileSync(DATA));
  const rows: string[][] = [];
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(10, start);
    if (end < 0) end = bytes.length;
    const fields: string[] = [];
    for (let field = start; field <= end;) {
      let stop = bytes.indexOf(9, field);
      if (stop < 0 || stop > end) stop = end;
      fields.push(bytes.toString('utf8', field, stop));
      field = stop + 1;
    }
    rows.push(fields);
    start = end + 1;
  }
  const count = rows.filter((fields) => fields[0] === 'P').length;
  const data: Gazetteer = {
    names: [], codes: [],
    country: new Uint16Array(count), admin1: new Uint16Array(count), admin2: new Uint16Array(count),
    latitude: new Float32Array(count), longitude: new Float32Array(count), population: new Uint32Array(count),
    keys: new Map(), postcodes: new Map(), countries: new Map(), regions: new Map(), regionNames: new Map(), airports: new Map(), byCountry: new Map(),
    airportNames: new Map(),
  };
  const codeIndex = new Map<string, number>();
  const code = (value: string) => {
    let index = codeIndex.get(value);
    if (index === undefined) {
      index = data.codes.push(value) - 1;
      codeIndex.set(value, index);
    }
    return index;
  };
  const add = (key: string, entry: number) => {
    const existing = data.keys.get(key);
    if (existing === undefined) data.keys.set(key, entry);
    else if (typeof existing === 'number') {
      if (existing !== entry) data.keys.set(key, [existing, entry]);
    } else if (!existing.includes(entry)) existing.push(entry);
  };
  let index = 0;
  for (const fields of rows) {
    if (fields[0] === 'P') {
      const [, name, ascii, country, admin1, admin2, latitude, longitude, population, alternates] = fields;
      data.names.push(name!);
      data.country[index] = code(country!);
      data.admin1[index] = code(admin1!);
      data.admin2[index] = code(admin2!);
      data.latitude[index] = Number(latitude);
      data.longitude[index] = Number(longitude);
      data.population[index] = Number(population);
      for (const key of [...nameKeys(name!), ...(ascii ? nameKeys(ascii) : [])]) add(key, index);
      for (const key of alternates ? alternates.split(',') : []) add(key, ~index);
      index += 1;
    } else if (fields[0] === 'Z') {
      const [, country, postcode, latitude, longitude] = fields;
      data.postcodes.set(`${country}:${postcode}`, { latitude: Number(latitude), longitude: Number(longitude) });
    } else if (fields[0] === 'C') {
      const [, country, name, longitude, latitude] = fields as [string, string, string, ...string[]];
      data.countries.set(country, { name, latitude: Number(latitude), longitude: Number(longitude) });
    } else if (fields[0] === 'R') {
      const [, country, admin1, keys] = fields as [string, string, string, string];
      data.regionNames.set(`${country}.${admin1}`, keys.split(','));
      for (const key of keys.split(',')) data.regions.set(key, [...data.regions.get(key) ?? [], { country, admin1 }]);
    } else if (fields[0] === 'A') {
      const [, code, country, latitude, longitude, name, town] = fields as [string, string, string, string, string, string, string];
      data.airports.set(code, { code, country, latitude: Number(latitude), longitude: Number(longitude), name, town });
    }
  }
  loaded = data;
  return data;
}

/** Loads the gazetteer ahead of the first request that needs it. */
export function preloadPlaces(): void {
  gazetteer();
}

function distanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = Math.PI / 180;
  const a = Math.sin((latitude2 - latitude1) * radians / 2) ** 2
    + Math.cos(latitude1 * radians) * Math.cos(latitude2 * radians) * Math.sin((longitude2 - longitude1) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** The gazetteer's places in a country. */
function countryPlaces(country: string): readonly number[] {
  const data = gazetteer();
  if (!data.byCountry.size) {
    data.country.forEach((code, index) => {
      const name = data.codes[code]!;
      const list = data.byCountry.get(name);
      if (list) list.push(index);
      else data.byCountry.set(name, [index]);
    });
  }
  return data.byCountry.get(country) ?? [];
}

/** How far a point is from a country: from the nearest of its towns. */
function countryDistanceKm(country: string, latitude: number, longitude: number): number {
  const data = gazetteer();
  let nearest = Infinity;
  for (const index of countryPlaces(country)) {
    nearest = Math.min(nearest, distanceKm(latitude, longitude, data.latitude[index]!, data.longitude[index]!));
  }
  return nearest;
}

/** The state or province of the town nearest a point in a country, by postal code ("IL", "ON", "NSW"). */
function regionNear(country: string, latitude: number, longitude: number): string | null {
  const data = gazetteer();
  let nearest = -1;
  let best = Infinity;
  for (const index of countryPlaces(country)) {
    const distance = distanceKm(latitude, longitude, data.latitude[index]!, data.longitude[index]!);
    if (distance < best) [nearest, best] = [index, distance];
  }
  if (nearest < 0) return null;
  const admin1 = data.codes[data.admin1[nearest]!] ?? '';
  const postal = Object.entries(ADMIN_CODES[country] ?? {}).find(([, code]) => code === admin1)?.[0];
  return postal ?? admin1;
}

/**
 * The zone of an airport a scan names by its IATA code: alone ("AMS"), as
 * forwarders write their air legs, with an airport word ("JFK Airport") or with
 * the airport's country or state ("BNE, AU"). A bare code places nothing on a
 * map unless the parcel's way bears it out (`placesForEvents`), but it can
 * still tell a scan's clock.
 */
export function airportTimeZone(location: string): string | null {
  const data = gazetteer();
  const text = location.trim();
  const { country, place } = trackingPlace(text);
  const airport = airportCode(data, text) ?? codedAirport(data, country ? place : text, country)?.airport;
  return airport ? placeTimeZone({ ...airport, precision: 'city', name: airport.town }) : null;
}

const ZONED_REGIONS = new Set(['US', 'CA', 'AU', 'BR']);
const zoneCache = new Map<string, string | null>();
const regionCache = new Map<string, string | null>();

/** The state or province of a town in a country whose zones follow them, cached. */
function townRegion(place: EventPlace): string | null {
  if (place.region || place.precision !== 'city') return place.region ?? null;
  const key = `${place.country}|${place.latitude.toFixed(2)}|${place.longitude.toFixed(2)}`;
  if (regionCache.has(key)) return regionCache.get(key)!;
  const region = regionNear(place.country, place.latitude, place.longitude);
  if (regionCache.size >= CACHE_SIZE) regionCache.clear();
  regionCache.set(key, region);
  return region;
}

/**
 * The zone a scan at this place keeps its clock on: its country's, or where a
 * country keeps several, its state's or province's (the US, Canada, Australia,
 * Brazil), the part's where a state is split by place (Florida's Panhandle),
 * or the zone whose principal place lies nearest. A place that names
 * only a country with several zones takes the one most of its people live on.
 * Null for a country the tz database does not know.
 */
export function placeTimeZone(place: EventPlace): string | null {
  if (place.precision === 'country') return (place.region ? regionZone(place.country, place.region) : null) ?? mainZone(place.country);
  const key = `${place.country}|${place.latitude.toFixed(2)}|${place.longitude.toFixed(2)}`;
  if (zoneCache.has(key)) return zoneCache.get(key)!;
  const region = ZONED_REGIONS.has(place.country) ? regionNear(place.country, place.latitude, place.longitude) : null;
  const zone = (region ? splitRegionZone(place.country, region, place.latitude, place.longitude) ?? regionZone(place.country, region) : null)
    ?? pointZone(place.country, place.latitude, place.longitude);
  if (zoneCache.size >= CACHE_SIZE) zoneCache.clear();
  zoneCache.set(key, zone);
  return zone;
}

/** The instant a time stands for and the offset it states, in minutes; none for UTC, which says no place's clock. */
function statedClock(time: string | null | undefined): { at: number; offset: number } | null {
  const raw = time?.trim() ?? '';
  if (!/[+-]\d\d:?\d\d$/u.test(raw)) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true });
  return parsed.isValid && parsed.offset !== 0 ? { at: parsed.toMillis(), offset: parsed.offset } : null;
}

function zoneOffset(zone: string | null, at: number): number | null {
  return zone ? DateTime.fromMillis(at, { zone }).offset : null;
}

/** The instant an ISO 8601 time stands for, when it gives its offset. */
function instant(time: string | null | undefined): number | null {
  if (!time || !/(?:Z|[+-]\d\d:?\d\d)$/i.test(time.trim())) return null;
  const value = Date.parse(time);
  return Number.isFinite(value) ? value : null;
}

/**
 * The scans the parcel was not at. A scan that records paperwork, or names only
 * a country, can be filed ahead of the parcel: customs clears it at the
 * destination's office while it is still abroad, and a destination carrier
 * registers it before it has left. The scans that handle it in a town say
 * where it is, and such a scan is away when:
 * - it lies more than 300 km off the way between the handling scans before
 *   and after it, measured from a country's nearest town;
 * - the parcel would have flown faster than a plane between it and the
 *   handling scan before or after it;
 * - the handling scans around it are in other countries, and the parcel
 *   only comes to its country later;
 * - it registers the parcel in a country it names alone, after the parcel
 *   was handled elsewhere and before it was handled there.
 */
function awayScans(
  places: readonly (EventPlace | null)[],
  stages: readonly (string | null | undefined)[],
  times: readonly (string | null | undefined)[],
): Set<number> {
  const away = new Set<number>();
  const paperwork = (index: number) => PAPERWORK_STAGES.has(stages[index] ?? '');
  const handled = places.flatMap((place, index) => place?.precision === 'city' && !paperwork(index) ? [index] : []);
  const reach = (from: EventPlace, to: EventPlace) => from.precision === 'country'
    ? countryDistanceKm(from.country, to.latitude, to.longitude)
    : distanceKm(from.latitude, from.longitude, to.latitude, to.longitude);
  places.forEach((place, index) => {
    if (!place || (place.precision === 'city' && !paperwork(index))) return;
    const before = handled.filter((at) => at < index).at(-1);
    const after = handled.find((at) => at > index);
    const offWay = () => {
      if (before === undefined || after === undefined) return false;
      const [from, to] = [places[before]!, places[after]!];
      return reach(place, from) + reach(place, to) - distanceKm(from.latitude, from.longitude, to.latitude, to.longitude) > AWAY_DETOUR_KM;
    };
    const at = instant(times[index]);
    const flown = (other: number | undefined) => {
      const then = other === undefined || at === null ? null : instant(times[other]);
      return then !== null && reach(place, places[other!]!) > PLANE_KMH * (Math.abs(at! - then) / 3_600_000 + CLOCK_SLACK_HOURS);
    };
    const elsewhere = (other: number | undefined) => other === undefined || places[other]!.country !== place.country;
    const ahead = () => after !== undefined && elsewhere(before) && elsewhere(after)
      && places.some((later, at) => at > after && later?.country === place.country && !paperwork(at));
    const unreached = () => place.precision === 'country' && REGISTRATION_STAGES.has(stages[index] ?? '') && before !== undefined
      && !handled.some((at) => at < index && places[at]!.country === place.country);
    if (offWay() || flown(before) || flown(after) || ahead() || unreached()) away.add(index);
  });
  return away;
}

/** `link`: an abbreviated linking word, or the first word it stands for. */
interface Token { key: string; start: number; end: number; link?: true }
/**
 * Where in its field a phrase was read, whether it is all the field says, and whether other
 * words of the name surround it (`middle`, "Example Reading Station Lockers").
 */
interface Phrase { key: string; text: string; rank: number; start: number; end: number; whole: boolean; middle?: boolean }

function tokens(text: string): Token[] {
  // Chinese, Japanese and Korean script is read by `cjkPhrases`. Latin letters next to it are
  // still a word: "Changsha市".
  return [...text.matchAll(/(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu)].flatMap((match) => {
    // "BARCELONA2": a depot number glued to the town.
    const word = /\p{L}/u.test(match[0]) ? match[0].replace(/\d+$/u, '') : match[0];
    // "TrondheimSorter": a facility word joined to its town.
    const [, town, facility] = /^(.*\p{Ll})(\p{Lu}\p{Ll}+)$/u.exec(word) ?? [];
    if (town && FACILITY_WORDS.has(nameKey(facility!))) {
      const end = match.index + town.length;
      return [{ key: nameKey(town), start: match.index, end }, { key: nameKey(facility!), start: end, end: end + facility!.length }];
    }
    const key = nameKey(word);
    return key ? [{ key, start: match.index, end: match.index + word.length }] : [];
  });
}

/**
 * The field's words as printed, then with each abbreviated linking word written out: "Weil a. Rhein"
 * is also "Weil am Rhein" and "Weil an Rhein". A letter after another is an initialism's: CTT's
 * "C.O. RIO DE MOURO" is its operations centre in Rio de Mouro.
 */
function spelledOut(field: string, list: Token[]): Token[][] {
  const dotted = (token: Token | undefined) => token?.key.length === 1 && field[token.end] === '.';
  const printed: Token[] = [];
  let variants: Token[][] = [[]];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]!;
    const next = list[index + 1];
    const paired = index > 0 && dotted(token) && dotted(next) && !field.slice(token.end + 1, next!.start).trim()
      ? ABBREVIATED_LINKS[`${token.key} ${next!.key}`] : undefined;
    const words = paired ?? (index > 0 && dotted(token) && !dotted(list[index - 1]) ? ABBREVIATED_LINKS[token.key] : undefined);
    if (!words) {
      printed.push(token);
      variants = variants.map((variant) => [...variant, token]);
      continue;
    }
    const end = paired ? next!.end : token.end;
    printed.push({ ...token, link: true }, ...(paired ? [next!] : []));
    variants = variants.flatMap((variant) => words.map((spelling) => [...variant,
      ...spelling.map((key, at) => ({ key, start: token.start, end, ...(at === 0 ? { link: true as const } : {}) }))]));
    if (paired) index += 1;
  }
  return printed.some((token) => token.link) ? [printed, ...variants] : [list];
}

// French carriers shorten Saint and Sainte: "ST QUENTIN FALLAVIER" is Saint-Quentin-Fallavier.
const SAINTS: Readonly<Record<string, string>> = { st: 'saint', ste: 'sainte' };

// Titles that begin a saint's name in a town's: San Fernando, Santa Cruz, São Paulo, Sankt Gallen.
const SAINT_TITLES = new Set(['san', 'santa', 'santo', 'sao', 'sant', 'saint', 'sainte', 'sankt']);

/** A word that says more of a name than a facility's or a division's word, a digit or a letter alone. */
function namesMore(token: Token): boolean {
  return token.key.length > 1 && /\p{L}/u.test(token.key) && !FACILITY_WORDS.has(token.key) && !DIVISION_WORDS.has(token.key);
}

/** A key with Saint and Sainte written out: "st albans" is "saint albans". */
function saintsWritten(key: string): string {
  return key.split(' ').map((word) => (Object.hasOwn(SAINTS, word) ? SAINTS[word]! : word)).join(' ');
}

/** The words as printed, then with Saint and Sainte written out where they are shortened. */
function withSaints(list: Token[]): Token[][] {
  const written = list.map((token) => Object.hasOwn(SAINTS, token.key) ? { ...token, key: SAINTS[token.key]! } : token);
  return written.some((token, index) => token !== list[index]) ? [list, written] : [list];
}

/** Phrases worth looking up, most specific first: "zurich mulligen", then "zurich". */
/** The key of the town text with brackets names as a whole, or ''. */
function qualifiedKey(data: Gazetteer, text: string): string {
  const parts = /^([^()]+)\(([^()]+)\)$/u.exec(text.trim());
  const keys = [nameKey(text), ...parts ? QUALIFIER_LINKS.map((link) => `${nameKey(parts[1]!)} ${link} ${nameKey(parts[2]!)}`) : []];
  return keys.find((key) => key && data.keys.has(key)) ?? '';
}

function phrases(field: string): Phrase[] {
  const found: Phrase[] = [];
  const add = (list: Token[], rank: number, whole = false, middle = false) => {
    if (!list.length) return;
    const key = list.map((token) => token.key).join(' ');
    const seen = found.find((phrase) => phrase.key === key);
    // "Guangdong" is all "Guangdong Province" says, once its administrative word is gone.
    if (seen) {
      seen.whole ||= whole;
      if (!middle) delete seen.middle;
    } else if (key.length >= 3) {
      const [start, end] = [list[0]!.start, list.at(-1)!.end];
      found.push({ key, text: field.slice(start, end), rank, start, end, whole, ...(middle ? { middle } : {}) });
    }
  };
  const spans = (list: Token[], offset: number) => {
    for (let count = list.length; count > 0; count -= 1) add(list.slice(0, count), offset + list.length - count + 1, count === list.length);
    // What follows a linking word tells the town apart and is not the town: "Chazelles-sur-Lyon" is
    // not in Lyon, nor "Bernau bei Berlin" in Berlin.
    const linked = list.findIndex((token, index) => index > 0 && (token.link || LINKING_WORDS.has(token.key)));
    const end = linked > 0 ? linked + 1 : list.length;
    for (let start = 1; start < end; start += 1) add(list.slice(start), offset + list.length + start);
    // "Example Reading Station Lockers": a town between other words.
    for (let start = 1; start < Math.min(end, list.length - 1); start += 1) {
      for (let end = start + 1; end < list.length && end - start <= MIDDLE_WORDS; end += 1) {
        add(list.slice(start, end), offset + 2 * list.length + start + list.length - end, false, true);
      }
    }
  };
  for (const all of spelledOut(field, tokens(field).filter((token) => !/^\d+$/.test(token.key))).flatMap(withSaints)) {
    // Facility words alone ("Hub", "Terminal") are no town, whatever GeoNames says.
    if (all.some((token) => !FACILITY_WORDS.has(token.key))) add(all, 0, true);
    let words = all.filter((token, index) => !FACILITY_WORDS.has(token.key)
      && !(ARTICLES.has(token.key) && FACILITY_WORDS.has(all[index + 1]?.key ?? '')));
    const lead = words.findIndex((token) => !LEADING_WORDS.has(token.key));
    const contracted = lead > 0 && words[lead - 1]!.key === 'del' ? words[lead - 1] : undefined;
    words = lead < 0 ? [] : words.slice(lead);
    spans(words, 0);
    // Spanish and Catalan write "de el" as "del": "AEROPUERTO DEL PRAT" is El Prat's.
    if (contracted) spans([{ ...contracted, key: 'el' }, ...words], 0);
    // "Zhejiang Province Jinhua City": the town without its administrative words.
    const bare = words.filter((token) => !DIVISION_WORDS.has(token.key));
    if (bare.length < words.length) spans(bare, 1);
  }
  return [...found, ...cjkPhrases(field)];
}

/**
 * Chinese and Japanese addresses run their divisions together, each closed by its
 * suffix: "广东省深圳市宝安区" is Guangdong province, Shenzhen city, Bao'an district.
 * A facility follows its town without one: "深圳转运中心".
 */
function cjkPhrases(field: string): Phrase[] {
  const found: Phrase[] = [];
  for (const run of field.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    let start = run.index;
    run[0].split(/(?<=[省市区县都府県])/u).forEach((segment, index) => {
      const end = start + segment.length;
      const add = (key: string, rank: number) => {
        if (key.length >= 2 && !CJK_FACILITY_WORDS.has(key) && !found.some((phrase) => phrase.key === key)) {
          found.push({ key, text: segment, rank, start, end, whole: false });
        }
      };
      const bare = segment.replace(/[省市区县都府県]$/u, '');
      add(segment, index * 2);
      add(bare, index * 2);
      for (let length = Math.min(bare.length - 1, 4); length >= 2; length -= 1) add(bare.slice(0, length), index * 2 + 3);
      start = end;
    });
  }
  return found;
}

interface Candidate {
  country: string;
  admin1: string;
  admin2: string;
  latitude: number;
  longitude: number;
  /** In thousands. */
  thousands: number;
  alternate: boolean;
  name: string;
  site?: string;
  hub?: boolean;
  /** A hub of one of the parcel's carriers. */
  own?: boolean;
  /** The name is the town's whatever the carrier wrote: its words are the facility's. */
  named?: boolean;
}

/**
 * The places a phrase can name. A hub's name replaces the towns of its country that share
 * it; a hub of the parcel's carrier stands beside them, ahead ("Buchs" is DPD's depot in
 * Buchs ZH on a DPD parcel, and still the town of St. Gallen or Aargau that says so).
 */
function candidates(data: Gazetteer, key: string, carriers: readonly string[]): Candidate[] {
  const hub = HUBS.get(key)?.find((entry) => !entry.carriers || entry.carriers.some((carrier) => carriers.includes(carrier)));
  // At its airport, or at its own point when its village is too small for the gazetteer.
  const airport = hub?.airport ? data.airports.get(hub.airport) : undefined;
  const point = airport ?? (hub?.latitude !== undefined && hub.longitude !== undefined ? { latitude: hub.latitude, longitude: hub.longitude } : undefined);
  const towns = [data.keys.get(key) ?? []].flat().flatMap((entry): Candidate[] => {
    const index = entry < 0 ? ~entry : entry;
    const country = data.codes[data.country[index]!]!;
    if (point && country === hub!.country && !hub!.carriers) return [];
    return [{
      country, admin1: data.codes[data.admin1[index]!] ?? '', admin2: data.codes[data.admin2[index]!] ?? '',
      latitude: data.latitude[index]!, longitude: data.longitude[index]!, thousands: data.population[index]!,
      alternate: entry < 0, name: data.names[index]!,
    }];
  });
  if (!hub || !point) return towns;
  return [...towns, {
    country: hub.country, admin1: hub.admin1 ?? '', admin2: '', latitude: point.latitude, longitude: point.longitude,
    thousands: HUB_THOUSANDS, alternate: false, name: hub.town ?? '', hub: true,
    ...(airport ? { site: airport.name } : hub.site ? { site: hub.site, named: true } : {}),
    ...(hub.carriers ? { own: true } : {}),
  }];
}

/**
 * A place, and whether the scan's own text says where it is rather than the town's name
 * alone. For a town: how many thousand people it has, and whether other towns share its name.
 */
interface Located {
  place: EventPlace; text: boolean; thousands?: number; shared?: boolean;
  /** Towns of the same name in the same country, far apart, that the text tells apart from `place` no better. */
  twins?: readonly EventPlace[];
}

/**
 * Turns one carrier location ("ZUERICH, CH", "Härkingen 4622", "Agence DPD de
 * La Crau (283)", "Germany") into a place, or null when the text names no
 * place we can be confident about. A wrong dot is worse than no dot.
 */
export function locatePlace(location: string | null | undefined, hints: PlaceHints = {}): EventPlace | null {
  const found = locate(location, hints);
  // Alone, a name two towns of a country share alike says neither.
  return found && !found.twins ? found.place : null;
}

const LOST = '\uFFFD';

/**
 * A town's name with the letters a carrier lost on the way, each a replacement
 * character, filled from the one spelling of a town of `country` that fits:
 * "SAINT-\uFFFDTIENNE" is Saint-Étienne's. A letter inside a word takes the
 * case of the letters beside it, one starting a word the town's own. Null when
 * no letter is lost or no single spelling fits.
 */
function restoredTownName(town: string, country: string): string | null {
  if (!town.includes(LOST)) return null;
  const chars = [...town];
  const source = chars.map((char) => char === LOST ? '(\\p{L})' : /[\s-]/u.test(char) ? '[\\s-]'
    : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  const pattern = new RegExp(`^${source}$`, 'iu');
  const data = gazetteer();
  const fills = new Set<string>();
  for (const index of countryPlaces(country)) {
    const match = pattern.exec(data.names[index]!);
    if (match) fills.add(match.slice(1).join(' '));
  }
  if (new Set([...fills].map((fill) => fill.toLowerCase())).size !== 1) return null;
  const letters = [...fills][0]!.split(' ');
  const letter = (char: string | undefined) => char !== undefined && char !== LOST && /\p{L}/u.test(char);
  return chars.map((char, at) => {
    if (char !== LOST) return char;
    const filled = letters.shift()!;
    if (!letter(chars[at - 1])) return filled;
    const beside = [chars[at - 1], chars[at + 1]].filter(letter);
    return beside.every((other) => other === other!.toUpperCase()) ? filled.toUpperCase() : filled.toLowerCase();
  }).join('');
}

/**
 * The result with the letters its scans' "Town, Country" places lost restored
 * (`restoredTownName`), in the place and wherever the wording names it.
 */
export function restoreLostLetters(result: CarrierResult): CarrierResult {
  if (!result.events?.some((event) => event.location?.includes(LOST))) return result;
  const restored = new Map<string, string>();
  for (const event of result.events) {
    const [, town, country] = /^(.+), ([^,]+)$/.exec(event.location ?? '') ?? [];
    const code = country ? countryCode(country) : null;
    const name = town && code && !restored.has(town) ? restoredTownName(town, code) : null;
    if (name) restored.set(town!, name);
  }
  if (!restored.size) return result;
  const spell = (text: string) => [...restored].reduce((spelled, [lost, name]) => spelled.replaceAll(lost, name), text);
  return {
    ...result,
    ...(result.last_status_text ? { last_status_text: spell(result.last_status_text) } : {}),
    events: result.events.map((event) => ({
      ...event,
      ...(event.location ? { location: spell(event.location) } : {}),
      ...(event.description ? { description: spell(event.description) } : {}),
    })),
  };
}

/** `split` reads a country the text names apart from its town; without it the whole text is the town's. */
function locate(location: string | null | undefined, hints: PlaceHints, split = true): Located | null {
  const text = location?.trim();
  // A military post office's base can be anywhere in its region (`militaryPostOffice`).
  if (!text || militaryPostOffice(text)) return null;
  const facility = facilityPlace(text);
  if (facility) return { place: facility, text: true };
  const zip = zipCodePlace(text, hints.countries ?? []);
  if (zip) return { place: zip, text: true };
  const data = gazetteer();
  const explicit = split ? trackingPlace(text) : { country: null, place: text };
  let country = explicit.country && data.countries.has(explicit.country) ? explicit.country : null;
  let rest = explicit.country ? explicit.place : text;
  const context = hints.countries ?? [];
  const carriers = hints.carriers ?? [];
  // A carrier's site named after the country it serves ("MR Pays Bas", Mondial Relay's Dutch network): that country.
  const site = HUBS.get(nameKey(text))?.find((hub) => !hub.town && hub.carriers?.some((carrier) => carriers.includes(carrier)));
  if (site) return countryPlace(data, site.country, true);
  const station = stationPlace(data, text, context, carriers);
  if (station) return station;
  // "CAN" on a parcel to Canada: a country's three-letter code, where the parcel is, is that country.
  const countryCode = split ? countryCodePlace(data, text, context) : null;
  if (countryCode) return countryCode;
  // "WA" on a parcel in Australia: a state alone is the state, not the country, town or airport its letters also name.
  const state = split ? statePlace(data, text, explicit, context) : null;
  if (state) return state;
  // "JFK Airport", "BNE, AU": the airport a code names, whatever town has its letters ("SAN" in Mali),
  // unless a town of 100,000 people has them where the airport is ("POA, BR" is Poá).
  const airportNamed = split ? codedAirport(data, rest, country) : null;
  const atNamedAirport = airportNamed && (airportNamed.worded || townThousands(data, airportNamed.airport) < NAMESAKE_THOUSANDS)
    ? atAirport(airportNamed.airport, carriers) : null;
  if (atNamedAirport) return atNamedAirport;
  const hinted = [...context];
  const admin: string[] = [];
  const postcodes: string[] = [];
  // How the country is written after the place, when it is: "(TO)", ", CH", " - CANADA".
  const written = country && rest && text.startsWith(rest) ? text.slice(rest.length) : '';
  // As its two-letter code, which a province can share: "PINEROLO (TO)" is in Turin's, not Tonga.
  const coded = country !== null && /[A-Z]/.test(written) && written.split(/[^A-Za-z]+/).filter(Boolean).every((word) => word === country);
  const bracketed = coded && written.includes('(');
  if (coded) admin.push(country!);
  // A code that ends the text without a comma is the country, unless the town
  // before it is in a state or province of that code: "CURITIBA - PR" is Paraná.
  let looseCountry = false;

  // A trailing code without a comma ("ZUERICH CH"), or one that is also a state
  // or canton ("KOELN, DE", "Buchs SG", "Bad Bevensen (DE)"): a hint either way. A depot's
  // number can follow it: "Example Town - IT (depot 0001)".
  const end = /(?:[\s,;]+([A-Z]{2})|\s*\(([A-Z]{2})\))(?:\s*\((?:\p{L}+\s+)?\d+\))?$/u.exec(rest);
  const trailing = end?.[1] ?? end?.[2];
  if (!country && trailing && data.countries.has(trailing)) {
    const before = rest.slice(0, end!.index + end![0].indexOf(trailing));
    rest = before.replace(/[\s,;(-]+$/, '');
    hinted.unshift(trailing);
    admin.push(trailing);
    if (end![1] && !/,|;/.test(before) && !ambiguousAddressCodes.has(trailing)) {
      country = trailing;
      looseCountry = true;
    }
  }
  for (const match of rest.matchAll(/\b([A-Z]{2,3})\b/g)) admin.push(match[1]!);
  for (const match of rest.matchAll(/(?:\b[A-Z]{1,2}-)?\b(\d{4,5})\b/g)) postcodes.push(match[1]!);
  // French departments and Italian provinces in brackets: "Sausheim 68 (68)", "Cologne (BS)".
  for (const match of rest.matchAll(/\((\d{2}|[A-Z]{2})\)|(?:^|\s)(\d{2})(?=\s|$)/g)) admin.push(match[1] ?? match[2]!);
  // A state, province or canton written where one belongs, as a field of its own or at the
  // end of one, before a facility's words at most ("Earth City, MO", "Buchs AG", "LAUREL, MD
  // 20707", "EXAMPLE NY DISTRIBUTION CENTER"): the town is in it.
  const stated = text.split(/[,;|()]/).flatMap((field) => {
    const words = field.trim().split(/\s+/);
    while (words.length > 1 && FACILITY_WORDS.has(nameKey(words.at(-1)!))) words.pop();
    return /(?:^|\s)([A-Z]{2})(?:\s+\d{4,5}(?:-\d{4})?)?$/.exec(words.join(' '))?.[1] ?? [];
  });

  // Postcodes only confirm a name, and only in a country the scan or the parcel
  // names: on its own, "2024" is more likely a year than a village.
  const countries = country ? [country] : hinted;
  let postcode: { latitude: number; longitude: number; country: string } | null = null;
  for (const code of postcodes) {
    for (const candidateCountry of countries) {
      const entry = data.postcodes.get(`${candidateCountry}:${code}`);
      if (entry) {
        postcode = { ...entry, country: candidateCountry };
        break;
      }
    }
    if (postcode) break;
  }

  const fields = rest.split(/[,;|()]|\s+-\s+/).map((field) => field.trim()).filter(Boolean);
  // "O Hare Airport": an airport by its own name, with no town to look near.
  const ownAirport = split && fields.length === 1 ? airportByName(data, fields[0]!, country) : null;
  const atOwnAirport = ownAirport ? atAirport(ownAirport, carriers) : null;
  if (atOwnAirport) return atOwnAirport;
  const fieldTokens = fields.map((field) => tokens(field));
  // "Frankfurt (Oder)": a town whose name has brackets of its own, or whose name joins what the brackets
  // tell it apart by: "Neustadt (Holstein)" is Neustadt in Holstein. In a country the text names, it
  // is that town however small, and no part of its name is another: "Essen (Oldenburg)" is not Essen.
  const qualified = rest.includes('(') ? qualifiedKey(data, rest) : '';
  const wholeName: Phrase[] = qualified ? [{ key: qualified, text: rest, rank: 0, start: 0, end: rest.length, whole: true }] : [];
  const fullName = qualified !== '' && candidates(data, qualified, carriers).some((place) => countries.includes(place.country));
  const fieldPhrases = fields.map((field, index) => fullName ? (index === 0 ? wholeName : [])
    : index === 0 ? [...wholeName, ...phrases(field)] : phrases(field));
  // Regions named elsewhere in the text ("STERLING - Virginia - USA", "广东省深圳市") tell towns of one name apart.
  const regions = fieldPhrases.flatMap((list, field) => list.flatMap((phrase) =>
    (data.regions.get(phrase.key) ?? []).map((region) => ({ ...region, field, start: phrase.start, end: phrase.end }))));
  // The longest region name wins where two overlap: "Morona-Santiago Province" is not Santiago Province.
  const outer = regions.filter((region) => !regions.some((other) => other.field === region.field
    && other.start < region.end && other.end > region.start && other.end - other.start > region.end - region.start));

  // "ITA" alone is Italy's code more often than Itá: a town of a country's three letters needs confirming.
  const countryCoded = COUNTRY_CODES.has(text);
  let best: { place: Candidate; score: number; text: string; key: string; field: number; start: number; end: number; backed: boolean; shared: boolean } | null = null;
  const scored: { place: Candidate; score: number; key: string; text: string; field: number; start: number; end: number }[] = [];
  // Whether the text names a town at all, even one nothing confirms.
  let namesTown = false;
  // The carrier's words for each town by its own name: "Asuncion del Paraguay" is Asunción, by any of its names.
  const ownWords = new Map<string, string>();
  const townId = (place: Candidate) => `${place.country}|${place.latitude}|${place.longitude}|${place.name}`;
  for (const [fieldIndex, list] of fieldPhrases.entries()) {
    for (const phrase of list) {
      const own = data.regions.get(phrase.key) ?? [];
      // Words of a region's name are towns of that region at most: the "Delgado"
      // of "Cabo Delgado Province" is in Mozambique or nowhere.
      const around = outer.filter((region) => region.field === fieldIndex && region.start <= phrase.start
        && region.end >= phrase.end && region.end - region.start > phrase.end - phrase.start);
      const local = around.filter((region) => region.country === country || hinted.includes(region.country));
      const within = local.length ? local : around;
      // A field that only names a region is that region when it follows the town
      // ("STERLING - Virginia - USA"), or when the region is in the parcel's countries
      // ("Santa Catarina" on a Brazilian parcel).
      const named = phrase.whole ? own.filter((region) => (!country || region.country === country)
        && (fieldIndex > 0 || region.country === country || hinted.includes(region.country))) : [];
      // A hub's name inside a longer place name is part of that name: "Beauregard-de-Terrasson"
      // is a village, not the agency at Terrasson, and "Roissy-en-Brie" is no airport. Saint
      // written out makes no longer name: "St Albans" is Saint Albans too.
      const longer = list.filter((other) => other.start <= phrase.start && other.end >= phrase.end
        && other.key.length > phrase.key.length && data.keys.has(other.key) && saintsWritten(other.key) !== saintsWritten(phrase.key));
      // So is a town's, when the longer name is a town where the text or the parcel is, or a city
      // and the shorter name no town there: "Cartagena de Indias" is in Colombia, "Santiago de
      // Compostela" in Spain, but "East London MC" on a British parcel is in London.
      const all = candidates(data, phrase.key, carriers);
      const here = (place: Candidate) => place.country === country || hinted.includes(place.country) || admin.includes(place.country);
      const anyHere = all.some((place) => !place.hub && here(place));
      const longerTowns = longer.flatMap((other) => candidates(data, other.key, carriers))
        .filter((place) => !place.hub && (here(place) || (!anyHere && place.thousands >= NAMESAKE_THOUSANDS)));
      // Elsewhere too, for a town nothing but its country confirms that is no city there: "Mill Hill Post
      // Office" is not in Hill.
      const longerAnywhere = longer.flatMap((other) => candidates(data, other.key, carriers)).filter((place) => !place.hub);
      const towns = all.filter((place) => (place.hub ? !longer.length : !longerTowns.length
        || longerTowns.some((other) => distanceKm(place.latitude, place.longitude, other.latitude, other.longitude) <= PART_OF_NAME_KM)));
      namesTown ||= towns.length > 0;
      for (const place of towns) {
        // A town may still be named like the region it lies in: Moscow in "…, Moscow",
        // Sofia in its own "Sofia-Capital" rather than the province of Sofia around it.
        const namesRegion = ` ${(data.regionNames.get(`${place.country}.${place.admin1}`) ?? []).join(' , ')} `.includes(` ${phrase.key} `);
        const inside = (scope: readonly Region[]) => scope.some((region) =>
          region.country === place.country && (region.admin1 === place.admin1 || namesRegion));
        // …or be the city a region is named after, wherever the line between them runs
        // ("Santo Domingo Province"); a village that shares the name is no such city.
        const namesake = (scope: readonly Region[]) => place.thousands >= NAMESAKE_THOUSANDS
          && own.some((region) => region.country === place.country
            && scope.some((other) => other.country === region.country && other.admin1 === region.admin1));
        if (within.length && !inside(within) && !namesake(within)) continue;
        if (named.length && !inside(named) && !(fieldIndex === 0 && namesake(named))) continue;
        // Nor does a region's name name a small town of its country outside it: "Mid Wales MC"
        // is no village called Wales in England.
        const home = own.filter((region) => region.country === place.country);
        if (home.length && !inside(home) && !namesake(home)) continue;
        const adminCodes = [place.admin1, place.admin2].filter(Boolean);
        const adminMatch = admin.some((code) => adminCodes.includes(code) || ADMIN_CODES[place.country]?.[code] === place.admin1)
          || regions.some((region) => region.country === place.country && region.admin1 === place.admin1
            && (region.field !== fieldIndex || region.end <= phrase.start || region.start >= phrase.end));
        // "Earth City, MO" is not Earth in Texas: a state its country has, and the town is not in.
        // Nor, on a parcel that may be in the US, is "Hillah, NC" the town abroad named so.
        const stateOf = (other: string) => stated.some((code) => code !== place.country
          && data.regionNames.has(`${other}.${ADMIN_CODES[other]?.[code] ?? code}`));
        if (!adminMatch && (stateOf(place.country) || hinted.some((other) => other !== place.country && stateOf(other)))) continue;
        const inCountry = place.country === country;
        if (country && !inCountry && !((looseCountry || coded) && adminMatch)) continue;
        const hint = hinted.indexOf(place.country);
        const postcodeMatch = postcode !== null && postcode.country === place.country
          && distanceKm(postcode.latitude, postcode.longitude, place.latitude, place.longitude) < 30;
        const confirmed = inCountry || hint >= 0 || adminMatch || postcodeMatch;
        if (!confirmed && (place.thousands < UNCONFIRMED_MIN_THOUSANDS || (countryCoded && !place.hub))) continue;
        // A town's other names include old ones (Trenton was Mill Hill): nothing confirming it, only a city's are known enough.
        if (!confirmed && place.alternate && place.thousands < NAMESAKE_THOUSANDS) continue;
        // Between other words, a town is a city where the parcel is, or something else confirms
        // it: "Queen Elizabeth Olympic Park" is not in Elizabeth, New Jersey.
        if (phrase.middle && !place.hub && !place.own && !adminMatch && !postcodeMatch
          && !((inCountry || hint >= 0) && place.thousands >= NAMESAKE_THOUSANDS)) continue;
        // A saint's title begins a longer name: "SAN FDO. DE H." is San Fernando de Henares, not San in Mali.
        if (SAINT_TITLES.has(phrase.key) && fieldTokens[fieldIndex]!.some((token) => token.start >= phrase.end && namesMore(token))) continue;
        // A name a division's word follows is that division's, not a town GeoNames counts no
        // people in: "Houjie District" is no town of Houjie.
        if (place.thousands === 0 && !place.hub && DIVISION_WORDS.has(fieldTokens[fieldIndex]!.find((token) => token.start >= phrase.end)?.key ?? '')) continue;
        if (longerAnywhere.length && !place.hub && !adminMatch && !postcodeMatch
          && !((inCountry || hint >= 0) && place.thousands >= NAMESAKE_THOUSANDS)
          && longerAnywhere.every((other) => distanceKm(place.latitude, place.longitude, other.latitude, other.longitude) > PART_OF_NAME_KM)) continue;
        if (!place.alternate && !ownWords.has(townId(place))) ownWords.set(townId(place), phrase.text);
        const score = Math.log10(Math.max(place.thousands, .3) * 1000)
          + (place.alternate ? 0 : 1.8)
          + (inCountry ? 4 : hint >= 0 ? 2.5 - Math.min(hint, 3) * .4 : 0)
          + (adminMatch ? 3 : 0) + (postcodeMatch ? 3 : 0) + (place.own ? 3 : 0)
          - phrase.rank * .3 - fieldIndex * .5;
        scored.push({ place, score, key: phrase.key, text: phrase.text, field: fieldIndex, start: phrase.start, end: phrase.end });
        if (!best || score > best.score) {
          best = { place, score, text: phrase.text, key: phrase.key, field: fieldIndex, start: phrase.start, end: phrase.end, backed: inCountry || adminMatch || postcodeMatch, shared: towns.length > 1 };
        }
      }
    }
  }

  if (best) {
    const county = countyIn(data, fieldPhrases[best.field] ?? [], best, carriers);
    const found = county ?? { place: best.place, text: (best.place.alternate && ownWords.get(townId(best.place))) || best.text };
    const atFound = found.place.hub ? null : airportFor(data, rest, fields[best.field] ?? rest, found.place, found.text, country);
    // A smaller town in the same region that ends the part of the text a city begins, close to it, is
    // the carrier's site there: "TORINO MONCALIERI" is a depot in Moncalieri. An airport the text names
    // comes first. A hyphen makes the two one name, a quarter of the city: "Zürich-Mülligen" is in
    // Zürich, and so is "ZUERICH MUELLIGEN", as Mülligen the town lies across a regional border.
    const first = fieldTokens[best.field]![0];
    const nearby = (other: (typeof scored)[number], km = SUBURB_MAX_KM) => other.place.country === best.place.country
      && other.place.admin1 === best.place.admin1 && !other.place.hub && other.place.thousands < best.place.thousands
      && distanceKm(best.place.latitude, best.place.longitude, other.place.latitude, other.place.longitude) <= km;
    // So is a smaller town that a city alone in brackets follows, a little farther off: "Kerpen (Köln)"
    // is in Kerpen.
    const whole = (field: number, from: number, to: number) => fieldTokens[field]!
      .every((token) => (token.start >= from && token.end <= to) || !/\p{L}/u.test(token.key));
    const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const bracketed = best.field > 0 && whole(best.field, best.start, best.end)
      && new RegExp(`${literal(fields[best.field - 1]!)}\\s*\\(\\s*${literal(fields[best.field]!)}\\s*\\)`, 'u').test(rest);
    const suburb = county || atFound || found.place.hub ? undefined : best.start === first?.start ? scored
      .filter((other) => other.field === best.field && other.start >= best.end && nearby(other)
        && !fields[best.field]!.slice(best.end, other.start).includes('-')
        && fieldTokens[best.field]!.every((token) => token.end <= other.end || !/\p{L}/u.test(token.key)))
      .sort((a, b) => b.score - a.score)[0] ?? (bracketed ? scored
      .filter((other) => other.field === best.field - 1 && whole(other.field, other.start, other.end) && nearby(other, BRACKETED_MAX_KM))
      .sort((a, b) => b.score - a.score)[0] : undefined) : undefined;
    const { place, text: carrierWords } = suburb ?? found;
    const airport = suburb ? null : atFound;
    // Keep the carrier's spelling unless it is shouting or all in small letters: "La Crau", but "Köln"
    // for "KOELN" and "Shenzhen" for "shenzhenshi".
    const name = (town: Candidate) => !town.named && /\p{Ll}/u.test(carrierWords) && /\p{Lu}/u.test(carrierWords) ? carrierWords : town.name;
    const twins = county || suburb || place.hub ? [] : scored.filter((other) => other.key === best.key && other.place.country === place.country
      && !other.place.hub && other.place.alternate === place.alternate && best.score - other.score < TWIN_SCORE
      && distanceKm(place.latitude, place.longitude, other.place.latitude, other.place.longitude) > PART_OF_NAME_KM);
    return {
      text: best.backed,
      thousands: place.thousands,
      shared: best.shared,
      place: {
        latitude: round(airport?.latitude ?? place.latitude),
        longitude: round(airport?.longitude ?? place.longitude),
        precision: 'city',
        country: place.country,
        name: name(place),
        ...(place.site ? { site: place.site } : airport ? { site: airport.name } : {}),
      },
      ...(twins.length ? { twins: twins.map(({ place: twin }) => ({
        latitude: round(twin.latitude), longitude: round(twin.longitude), precision: 'city' as const, country: twin.country, name: name(twin),
      })) } : {}),
    };
  }
  // "SCSEZA": a UPU office of exchange, in the town of the airport its code names.
  const office = split ? officePlace(data, rest, context, carriers) : null;
  if (office) return office;
  // A hub named after a city that shares a country's name: GIG Logistics' "BENIN HUB"
  // is in Benin City. On a parcel in the city's country, and not in the named one, the
  // city it is, when it is a large one.
  const facilityWords = tokens(rest);
  if (country && !context.includes(country) && text.endsWith(rest) && facilityWords.length
    && facilityWords.every((token) => FACILITY_WORDS.has(token.key))) {
    const town = locate(text, hints, false);
    if (town?.place.precision === 'city' && context.includes(town.place.country) && (town.thousands ?? 0) >= NAMESAKE_THOUSANDS) return town;
  }
  // A two-letter code with no town of its country before it, on a parcel nothing else puts
  // there, may be no country at all: Royal Mail ends its mail centres with MC and its
  // delivery offices with DO, India's states are written like countries. A town the text
  // names where the parcel is settles it; so does any town, for a code no comma or bracket
  // sets apart. A code of that kind with no town at all is then no place either. One the
  // text also names in words, the country or a region of it, is that country:
  // "Example Town, HOLLAND, NL" is not in Holland, Michigan.
  const worded = outer.some((region) => region.country === country)
    || fields.some((field) => { const named = trackingPlace(field); return named.country === country && !named.place; });
  if (rest && (looseCountry || coded) && !context.includes(country!) && !worded) {
    // Carriers Royal Mail hands parcels to write its sites its way: "Thames Valley MC" is its
    // centre in Swindon whatever the carrier, and "Mid Wales MC" somewhere in Wales.
    const royalMail = looseCountry && (country === 'MC' || country === 'DO');
    const british = royalMail ? locate(rest, { countries: ['GB', ...context], carriers: [...carriers, 'royal-mail'] }) : null;
    if (british?.place.precision === 'city' && british.place.country === 'GB') return british;
    // Past a comma or a bracket, only a town known on its own: no hamlet where the parcel is.
    const town = locate(rest, looseCountry ? hints : { carriers });
    if (town?.place.precision === 'city' && (looseCountry || context.includes(town.place.country))) return town;
    if (royalMail) return regions.some((region) => region.country === 'GB') ? countryPlace(data, 'GB', true) : null;
    if ((looseCountry || bracketed) && context.length) return null;
  }
  // India Post ends an office's name with its PIN code, and abbreviates some names
  // past reading ("KOL AP TMO 700052"): the PIN's town places a scan that names no
  // town, when the scan or the parcel is in India. A town nothing confirmed is no
  // abbreviation, and its six digits may be a Swiss Post site ("Daillens … 131070").
  const pin = !namesTown && (country === 'IN' || (!country && hinted.includes('IN'))) ? pinPlace(data, rest) : null;
  if (pin) return { place: pin, text: true };
  // A region alone places its country: "Guangdong Province", or "Santa Catarina"
  // on a Brazilian parcel, though Cape Verde has one too.
  // A code nothing backs is a guess: it tells the scans around it nothing.
  const guessed = Boolean(rest) && (looseCountry || bracketed) && !context.includes(country!);
  // "DPD GERMANY DE": a carrier's operation in a country it names, where the parcel is, or names
  // as "-ian" ("Latvian sorting center"). Two letters are no name: "FR0059" is a depot.
  country ??= fields.map((field) => tokens(field).filter((token) => !FACILITY_WORDS.has(token.key))
    .map((token) => field.slice(token.start, token.end)).join(' '))
    .filter((words) => !/^[A-Z]{2}$/.test(words)).map((words) => /^\p{L}+ian$/iu.test(words) ? words.slice(0, -1) : words).map(trackingPlace)
    .find((named) => named.country && !named.place && hinted.includes(named.country))?.country ?? null;
  if (!country) {
    const named = fieldPhrases.flatMap((list) => list.filter((phrase) => phrase.whole && phrase.key.length >= 4
      && !VAGUE_REGIONS.has(phrase.key)).map((phrase) => {
      const all = new Set((data.regions.get(phrase.key) ?? []).map((region) => region.country));
      const local = new Set([...all].filter((code) => hinted.includes(code)));
      // A region named by points of the compass alone is one where the parcel is: Royal Mail's
      // "South West Parcel Hub" is not in Cameroon.
      if (phrase.key.split(' ').every((word) => VAGUE_REGIONS.has(word) || word === 'far')) return local;
      return all.size > 1 && local.size ? local : all;
    }));
    country = named.find((set) => set.size === 1)?.values().next().value ?? null;
  }
  return country ? countryPlace(data, country, !guessed) : null;
}

/**
 * A state or province alone, by the code carriers print, as the country it is in with its code:
 * "VIC, AU", "SA AUSTRALIA", or "VIC" in the first country the parcel is likely in that has one,
 * whatever else its letters name (Vic in Spain, Tashkent's airport). Letters that are also a
 * country's are that country where the parcel may be: "SA" is Saudi Arabia on a parcel through it.
 */
function statePlace(data: Gazetteer, text: string, explicit: { country: string | null; place: string }, context: readonly string[]): Located | null {
  const spaced = !explicit.country && /^[A-Z]{2,3}\s+\p{L}/u.test(text) ? trackingPlace(text.replace(/\s+/, ', ')) : null;
  const stated = explicit.country && explicit.place ? explicit : spaced?.country ? spaced : null;
  const code = stated ? stated.place : text;
  if (!/^[A-Z]{2,3}$/.test(code) || (!explicit.place && context.includes(code))) return null;
  const country = stated ? stated.country : context.find((other) => ADMIN_CODES[other]?.[code]);
  const found = country && ADMIN_CODES[country]?.[code] ? countryPlace(data, country, true) : null;
  return found && { ...found, place: { ...found.place, region: code } };
}

function countryPlace(data: Gazetteer, country: string, text: boolean): Located | null {
  const area = data.countries.get(country);
  return area ? { text, place: { latitude: area.latitude, longitude: area.longitude, precision: 'country', country, name: area.name } } : null;
}

/**
 * The airport a field names by the words of its name, with a word that says it is one, when no
 * town has them: "O Hare Airport" is Chicago's, though Halle is also called Hare, and "Boston
 * Airport" no airport of Manchester-Boston. Only a name of two words or six letters one airport has.
 */
function airportByName(data: Gazetteer, field: string, country: string | null): Airport | null {
  const keys = tokens(field).map((token) => token.key);
  if (!keys.some((key) => AIRPORT_WORDS.has(key))) return null;
  const name = keys.filter((key) => !AIRPORT_WORDS.has(key) && !AIRPORT_NAME_WORDS.has(key)).join(' ');
  if (!name.includes(' ') && name.length < 6) return null;
  if (!data.airportNames.size) {
    for (const airport of data.airports.values()) {
      const town = new Set(nameKey(airport.town).split(' '));
      const own = nameKey(airport.name).split(' ').filter((word) => word && !AIRPORT_NAME_WORDS.has(word) && !town.has(word)).join(' ');
      if (own) data.airportNames.set(own, [...data.airportNames.get(own) ?? [], airport]);
    }
  }
  const named = data.keys.has(name) ? [] : (data.airportNames.get(name) ?? []).filter((airport) => !country || airport.country === country);
  return named.length === 1 ? named[0]! : null;
}

/**
 * The airport a scan names, near the town it names: by its code in brackets
 * ("Frankfurt Airport (FRA)"), by its own name ("LONDON-HEATHROW", "Chicago O Hare",
 * "LONDON - GATWICK", "Narita Airport, Tokyo"), or as the one airport of
 * the town when the text says airport ("LIEGE AIRPORT"). `text` is the location without
 * the country it names, `field` the part of it the town was read from: in "Soyapango,
 * San Salvador" the region is no airport.
 */
function airportFor(data: Gazetteer, text: string, field: string, town: Candidate, written: string, country: string | null): Airport | null {
  const words = new Set(tokens(text).map((token) => token.key));
  const fieldWords = new Set(tokens(field).map((token) => token.key));
  const townWords = new Set([...nameKey(written).split(' '), ...nameKey(town.name).split(' ')]);
  const within = (km: number) => [...data.airports.values()].filter((airport) => (!country || airport.country === country)
    && distanceKm(town.latitude, town.longitude, airport.latitude, airport.longitude) <= km);
  const nearby = within(AIRPORT_MAX_KM);
  for (const [, code] of text.matchAll(/\(([A-Z]{3})\)/g)) {
    const named = nearby.find((airport) => airport.code === code);
    if (named) return named;
  }
  // "Chicago O Hare": the words of its own name, together.
  const fieldName = ` ${tokens(field).map((token) => token.key).filter((word) => !AIRPORT_NAME_WORDS.has(word)).join(' ')} `;
  const distinct = nearby.filter((airport) => {
    const own = airportOwnWords(airport, townWords);
    return own.some((word) => word.length >= 5 && fieldWords.has(word))
      || (own.join('').length >= 4 && fieldName.includes(` ${own.join(' ')} `));
  });
  if (distinct.length === 1) return distinct[0]!;
  // A part of the text that is an airport's own name and no town's ("GATWICK", where "Baiyun" is
  // a district), or names it with a word that says it is one ("Narita International Airport"),
  // comes before the airport that serves the town.
  const parts = text.split(/[,;|()]|\s+-\s+/).map((part) => {
    const keys = tokens(part).map((token) => token.key);
    const name = keys.filter((key) => !AIRPORT_WORDS.has(key) && !AIRPORT_NAME_WORDS.has(key) && !townWords.has(key)).join(' ');
    return { name, worded: keys.some((key) => AIRPORT_WORDS.has(key)) };
  }).filter((part) => part.name.length >= 4 && (part.worded || !data.keys.has(part.name)));
  const named = within(parts.some((part) => part.worded) ? NAMED_AIRPORT_MAX_KM : AIRPORT_MAX_KM).filter((airport) => {
    const own = airportOwnWords(airport, townWords).join(' ');
    const served = nameKey(airport.town.split(/[,(]/)[0]!);
    return parts.some((part) => (own.length >= 4 && part.name === own) || (part.worded
      && ((own.length >= 4 && ` ${part.name} `.includes(` ${own} `)) || part.name === served)));
  });
  if (named.length === 1) return named[0]!;
  if (![...words].some((word) => AIRPORT_WORDS.has(word))) return null;
  const serving = nearby.filter((airport) => [...townWords].some((word) => word.length >= 3
    && ` ${nameKey(airport.name)} ${nameKey(airport.town)} `.includes(` ${word} `)));
  return serving.length === 1 ? serving[0]! : null;
}

/**
 * The words of an airport's name that tell it from the others, without the scan's town and the
 * town it serves before them: "Seoul Gimpo" is Gimpo, and "INCHEON NEAR SEOUL" not there.
 * An airport named after its town alone has none: "Kaunas" is the town.
 */
function airportOwnWords(airport: Airport, townWords: ReadonlySet<string>): string[] {
  const served = new Set(nameKey(airport.town.split(/[,(]/)[0]!).split(' '));
  const words = nameKey(airport.name).split(' ').filter((word) => word && !AIRPORT_NAME_WORDS.has(word));
  while (words.length > 1 && served.has(words[0]!)) words.shift();
  return words.every((word) => served.has(word)) ? [] : words.filter((word) => !townWords.has(word));
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// A station a carrier names by its town's airport code and a number: "BLQ 01", "NAP02".
const STATION = /^([A-Z]{3})[\s_-]?\d{1,2}$/;

/**
 * The town of a station a carrier names by an airport's code and a number, as iMile names its
 * Italian ones ("BLQ 01" would be Bologna's), when the parcel is in the airport's country. A
 * bare code places nothing here, and neither does a code whose airport is in a country nothing puts
 * the parcel in: three letters are too often something else.
 */
function stationPlace(data: Gazetteer, text: string, countries: readonly string[], carriers: readonly string[]): Located | null {
  const airport = airportCode(data, STATION.exec(text)?.[1] ?? '');
  const town = airport && countries.includes(airport.country) ? airportTown(airport, carriers) : null;
  return town && { ...town, text: true };
}

/**
 * A county-level city, a county or a town a Chinese address names after the city found, in the
 * same province and within 150 km of it: "浙江省金华市义乌市" is Yiwu, not Jinhua.
 */
function countyIn(
  data: Gazetteer, list: readonly Phrase[], found: { place: Candidate; text: string; end: number }, carriers: readonly string[],
): { place: Candidate; text: string } | null {
  if (!/\p{Script=Han}市$/u.test(found.text)) return null;
  for (const phrase of list) {
    if (phrase.start < found.end || !/\p{Script=Han}[市县镇乡鎮鄉]$/u.test(phrase.text)) continue;
    const town = candidates(data, phrase.key, carriers).find((place) => place.country === found.place.country
      && place.admin1 === found.place.admin1 && !place.hub
      && distanceKm(place.latitude, place.longitude, found.place.latitude, found.place.longitude) <= COUNTY_MAX_KM);
    if (town) return { place: town, text: phrase.text };
  }
  return null;
}

/** The airport of an IATA code as carriers write one: three capitals that are no facility word ("HUB"). */
function airportCode(data: Gazetteer, code: string): Airport | undefined {
  return /^[A-Z]{3}$/.test(code) && !FACILITY_WORDS.has(code.toLowerCase()) ? data.airports.get(code) : undefined;
}

/**
 * The airport a scan names by its code, with words that say so: an airport word ("JFK
 * Airport", "JFK International Airport"), or the airport's own country or state after it
 * ("BNE, AU", "JFK, NY"). `rest` is the text without the country it names, `country` that
 * country. `worded` tells the first kind.
 */
function codedAirport(data: Gazetteer, rest: string, country: string | null): { airport: Airport; worded: boolean } | null {
  const [field = '', ...others] = rest.split(/[,;|()]|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const words = field.match(/[\p{L}\p{N}]+/gu) ?? [];
  const airports = words.flatMap((word) => airportCode(data, word) ?? []);
  if (airports.length !== 1) return null;
  const [airport] = airports as [Airport];
  const keys = words.filter((word) => word !== airport.code).map(nameKey);
  if (!keys.every((key) => AIRPORT_WORDS.has(key) || AIRPORT_NAME_WORDS.has(key)) || (country && country !== airport.country)) return null;
  const worded = keys.some((key) => AIRPORT_WORDS.has(key));
  const region = others.length ? regionNear(airport.country, airport.latitude, airport.longitude) : null;
  // An operator in brackets says nothing against the airport: "MUC(DE-POST), DE".
  const operator = (other: string) => tokens(other).every((token) => FACILITY_WORDS.has(token.key) || token.key === airport.country.toLowerCase());
  if (!others.every((other) => other === airport.country || other === region || operator(other))) return null;
  return worded || country || others.length ? { airport, worded } : null;
}

/** How many thousand people the largest town with an airport's code for its name has in the airport's country. */
function townThousands(data: Gazetteer, airport: Airport): number {
  const places = [data.keys.get(nameKey(airport.code)) ?? []].flat().map((entry) => entry < 0 ? ~entry : entry);
  return Math.max(0, ...places.filter((index) => data.codes[data.country[index]!] === airport.country).map((index) => data.population[index]!));
}

/** The country a text names by its three-letter code alone ("ITA"), on a parcel in that country. */
function countryCodePlace(data: Gazetteer, text: string, countries: readonly string[]): Located | null {
  const country = /^[A-Z]{3}$/.test(text) ? COUNTRY_CODES.get(text) : undefined;
  const area = country && countries.includes(country) ? data.countries.get(country) : undefined;
  return area ? { text: true, place: { latitude: area.latitude, longitude: area.longitude, precision: 'country', country: country!, name: area.name } } : null;
}

/** The town an airport serves, by the name OurAirports gives it ("Sydney (Mascot)"), when it lies within 60 km. */
function airportTown(airport: Airport, carriers: readonly string[]): Located | null {
  const town = locate(airport.town, { countries: [airport.country], carriers }, false);
  // Of towns that share the name, the airport's.
  const place = town && [town.place, ...town.twins ?? []].find((place) => place.precision === 'city' && place.country === airport.country
    && distanceKm(place.latitude, place.longitude, airport.latitude, airport.longitude) <= AIRPORT_MAX_KM);
  return town && place ? { ...town, place, twins: undefined } : null;
}

/** A scan at an airport: the airport's point, under the name of the town it serves. */
function atAirport(airport: Airport, carriers: readonly string[]): Located | null {
  const town = airportTown(airport, carriers);
  return town && {
    ...town, text: true,
    place: { ...town.place, latitude: round(airport.latitude), longitude: round(airport.longitude), site: airport.name },
  };
}

// UPU offices of exchange whose code names a UN/LOCODE location that no airport of their country
// has, by that location's name: "FRROIC" is the export office at Roissy-en-France, "DEROUA"
// Rodgau's parcel centre.
const OFFICE_LOCATIONS = new Map([
  ['FRROI', 'Roissy-en-France'], ['DEROU', 'Rodgau'], ['GBLAL', 'Langley'], ['PTRDM', 'Rio de Mouro'],
]);

/**
 * The town of a UPU office of exchange, by its code: its country, the code of its town's
 * airport or another UN/LOCODE location, and a letter for the office ("SCSEZA" is the
 * Seychelles' office by Mahé airport). The airport has to be in that country. Text that is a
 * town comes first: "ARUSHA" is no Argentinian office. bpost follows the code with that
 * country's name: "BEBRUA Belgium". A code whose location no list holds, or whose letters
 * another country's airport has, is in its country when the parcel is known to be there and
 * no town has its letters for a name: "BEDALE" is a small English town, not a Belgian office.
 */
function officePlace(data: Gazetteer, text: string, context: readonly string[], carriers: readonly string[]): Located | null {
  const [, country, code, named] = /^([A-Z]{2})([A-Z]{3})[A-Z0-9](?:\s+(\S.*?)(?:\s+\1)?)?$/.exec(text) ?? [];
  if (!country || (named && nameKey(named) !== nameKey(data.countries.get(country)?.name ?? ''))) return null;
  const airport = airportCode(data, code ?? '');
  const location = OFFICE_LOCATIONS.get(`${country}${code}`);
  const town = airport && airport.country === country ? airportTown(airport, carriers)
    : location ? locate(location, { countries: [country], carriers }, false) : null;
  if (town) return town.place.country === country ? { ...town, text: true } : null;
  return context.includes(country) && !data.keys.has(nameKey(text)) ? countryPlace(data, country, true) : null;
}

// ISO 3166-1 alpha-3 country codes, which some carriers write for a country: "CAN" is Canada as
// often as Guangzhou's airport.
const COUNTRY_CODES = new Map(`
  ABW:AW AFG:AF AGO:AO AIA:AI ALA:AX ALB:AL AND:AD ARE:AE ARG:AR ARM:AM ASM:AS ATA:AQ ATF:TF ATG:AG AUS:AU
  AUT:AT AZE:AZ BDI:BI BEL:BE BEN:BJ BES:BQ BFA:BF BGD:BD BGR:BG BHR:BH BHS:BS BIH:BA BLM:BL BLR:BY BLZ:BZ
  BMU:BM BOL:BO BRA:BR BRB:BB BRN:BN BTN:BT BVT:BV BWA:BW CAF:CF CAN:CA CCK:CC CHE:CH CHL:CL CHN:CN CIV:CI
  CMR:CM COD:CD COG:CG COK:CK COL:CO COM:KM CPV:CV CRI:CR CUB:CU CUW:CW CXR:CX CYM:KY CYP:CY CZE:CZ DEU:DE
  DJI:DJ DMA:DM DNK:DK DOM:DO DZA:DZ ECU:EC EGY:EG ERI:ER ESH:EH ESP:ES EST:EE ETH:ET FIN:FI FJI:FJ FLK:FK
  FRA:FR FRO:FO FSM:FM GAB:GA GBR:GB GEO:GE GGY:GG GHA:GH GIB:GI GIN:GN GLP:GP GMB:GM GNB:GW GNQ:GQ GRC:GR
  GRD:GD GRL:GL GTM:GT GUF:GF GUM:GU GUY:GY HKG:HK HMD:HM HND:HN HRV:HR HTI:HT HUN:HU IDN:ID IMN:IM IND:IN
  IOT:IO IRL:IE IRN:IR IRQ:IQ ISL:IS ISR:IL ITA:IT JAM:JM JEY:JE JOR:JO JPN:JP KAZ:KZ KEN:KE KGZ:KG KHM:KH
  KIR:KI KNA:KN KOR:KR KWT:KW LAO:LA LBN:LB LBR:LR LBY:LY LCA:LC LIE:LI LKA:LK LSO:LS LTU:LT LUX:LU LVA:LV
  MAC:MO MAF:MF MAR:MA MCO:MC MDA:MD MDG:MG MDV:MV MEX:MX MHL:MH MKD:MK MLI:ML MLT:MT MMR:MM MNE:ME MNG:MN
  MNP:MP MOZ:MZ MRT:MR MSR:MS MTQ:MQ MUS:MU MWI:MW MYS:MY MYT:YT NAM:NA NCL:NC NER:NE NFK:NF NGA:NG NIC:NI
  NIU:NU NLD:NL NOR:NO NPL:NP NRU:NR NZL:NZ OMN:OM PAK:PK PAN:PA PCN:PN PER:PE PHL:PH PLW:PW PNG:PG POL:PL
  PRI:PR PRK:KP PRT:PT PRY:PY PSE:PS PYF:PF QAT:QA REU:RE ROU:RO RUS:RU RWA:RW SAU:SA SDN:SD SEN:SN SGP:SG
  SGS:GS SHN:SH SJM:SJ SLB:SB SLE:SL SLV:SV SMR:SM SOM:SO SPM:PM SRB:RS SSD:SS STP:ST SUR:SR SVK:SK SVN:SI
  SWE:SE SWZ:SZ SXM:SX SYC:SC SYR:SY TCA:TC TCD:TD TGO:TG THA:TH TJK:TJ TKL:TK TKM:TM TLS:TL TON:TO TTO:TT
  TUN:TN TUR:TR TUV:TV TWN:TW TZA:TZ UGA:UG UKR:UA UMI:UM URY:UY USA:US UZB:UZ VAT:VA VCT:VC VEN:VE VGB:VG
  VIR:VI VNM:VN VUT:VU WLF:WF WSM:WS XKX:XK YEM:YE ZAF:ZA ZMB:ZM ZWE:ZW
`.trim().split(/\s+/).map((pair) => pair.split(':') as [string, string]));

/**
 * The town of the Indian PIN code a scan ends with. A foreign airport's code, alone or
 * after its country's, names an office of exchange abroad ("Office - FRA 400051",
 * "Office - DEFRA …"): the PIN is then the Indian office's, not where the scan happened.
 */
/**
 * USPS places some scans only at a ZIP Code ("ZIP Code 60600", or "60600,60600" on a parcel
 * that may be in the US): the town its first three digits are named for, when most of their
 * codes are that town's.
 */
function zipCodePlace(text: string, countries: readonly string[]): EventPlace | null {
  const prefix = /^ZIP Code (\d{3})\d{2}(?:-\d{4})?$/i.exec(text)?.[1]
    ?? (countries.includes('US') ? /^(\d{3})(\d{2}),\s*\1\2$/.exec(text)?.[1] : undefined);
  if (!prefix) return null;
  zipPrefixes ??= (JSON.parse(readFileSync(ZIPCODES, 'utf8')) as { prefixes: Record<string, [string, string, number, number]> }).prefixes;
  const town = zipPrefixes[prefix];
  return town ? { latitude: town[2], longitude: town[3], precision: 'city', country: 'US', name: town[0] } : null;
}

function pinPlace(data: Gazetteer, text: string): EventPlace | null {
  const pin = /(?:^|\s)([1-8]\d{5})$/.exec(text)?.[1];
  // Russian, Chinese and other six-digit postcodes come with their own script.
  if (!pin || /[^\x20-\x7e]/.test(text)) return null;
  for (const [, prefix, code] of text.matchAll(/\b([A-Z]{2})?([A-Z]{3})\b/g)) {
    const airport = airportCode(data, code!);
    if (airport && airport.country !== 'IN' && (!prefix || prefix === airport.country)) return null;
  }
  pincodes ??= JSON.parse(readFileSync(PINCODES, 'utf8')) as Pincodes;
  const { ranges, towns } = pincodes;
  const value = Number(pin);
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last, town] = ranges[middle]!;
    if (value < first) high = middle - 1;
    else if (value > last) low = middle + 1;
    else {
      const [name, latitude, longitude] = towns[town]!;
      return { latitude, longitude, precision: 'city', country: 'IN', name };
    }
  }
  return null;
}

/** A sorting centre the table knows, by its number and the town its name starts with. */
function facilityPlace(text: string): EventPlace | null {
  const match = /^(.*\S)\s+(\d{6})$/.exec(text);
  const facility = match && FACILITIES.get(`CH:${match[2]}`);
  if (!facility || !`${nameKey(match[1]!)} `.startsWith(`${nameKey(facility.town)} `)) return null;
  const { latitude, longitude, country, town, name } = facility;
  return { latitude, longitude, precision: 'city', country, name: town, ...(name === town ? {} : { site: name }) };
}

/** The carrier's own point in place of the town's centre, when the two agree. */
function atPoint(place: EventPlace | null, point: EventPoint | null | undefined): EventPlace | null {
  if (!place || !point || place.precision !== 'city') return place;
  if (distanceKm(place.latitude, place.longitude, point.latitude, point.longitude) > POINT_MAX_KM) return place;
  return { ...place, latitude: point.latitude, longitude: point.longitude };
}

const cache = new Map<string, Located | null>();
const CACHE_SIZE = 20_000;

function cachedPlace(location: string | null | undefined, countries: readonly string[], carriers: readonly string[]): Located | null {
  const key = `${countries.join(',')}|${carriers.join(',')}|${location ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  const place = locate(location, { countries, carriers });
  if (cache.size >= CACHE_SIZE) cache.clear();
  cache.set(key, place);
  return place;
}

/** The countries a carrier delivers in under its own name, home first, and its clock's. */
function carrierHomes(carrier: string): string[] {
  const definition = (CARRIER_DEFINITIONS as Record<string, { countries?: readonly string[]; timezone?: string } | undefined>)[carrier];
  if (!definition) return [];
  const countries = definition.countries ?? [];
  const clock = definition.timezone ? timeZoneCountry(definition.timezone) : null;
  return [...(countries.length <= HOME_COUNTRIES_MAX ? countries : []), ...(clock ? [clock] : [])];
}

/**
 * Places for a parcel's scans, oldest first. A scan that names no country
 * borrows one from the scans around it, then the destination and the
 * carriers' home countries, so "Buchs" after "Zürich" stays in Switzerland.
 * A world city, or a town ten times larger than that country's namesake,
 * keeps its own place when it lies nearer the way between the scans around it.
 * A town only its name places, in a country nothing else puts the parcel in,
 * is a namesake and gets no place when it is thousands of kilometres off the
 * way between the scans around it, or, where the scans stop, that far from
 * them and from the parcel's countries, under a name other towns share,
 * without being a world city. A carrier's own point for a scan, or for
 * another scan with the same text, moves it from the town's centre to the
 * facility, if the two are within 30 km of each other. Given the scans'
 * stages and times, a scan the parcel was not at gets no place (see `awayScans`).
 */
export function placesForEvents(
  locations: readonly (string | null | undefined)[],
  { destinationCountry, carrierCountries = [], carriers = [], points = [], stages = [], times = [] }: {
    destinationCountry?: string | null;
    carrierCountries?: readonly string[];
    /** The parcel's carriers by catalog id, the one delivering now first: their countries and their own hubs. */
    carriers?: readonly string[];
    /** The carrier's own point for each scan, where it gave one. */
    points?: readonly (EventPoint | null | undefined)[];
    /** Each scan's stage, such as `customs`. */
    stages?: readonly (string | null | undefined)[];
    /** When each scan happened, as an ISO 8601 time with its offset. */
    times?: readonly (string | null | undefined)[];
  } = {},
): (EventPlace | null)[] {
  const base = [...new Set([destinationCountry, ...carrierCountries, ...carriers.flatMap(carrierHomes)].filter((code): code is string => Boolean(code)))];
  const looked = locations.map((location) => cachedPlace(location, base, carriers));
  // A carrier can place some scans of an office and not others: they all share it.
  const pointAt = new Map<string, EventPoint>();
  locations.forEach((location, index) => {
    const point = points[index];
    if (location && point && !pointAt.has(location.trim())) pointAt.set(location.trim(), point);
  });
  // What holds a scan where it is: its own text, or a country the parcel is known to be in.
  const anchored = (found: Located | null): boolean => found !== null && (found.text || base.includes(found.place.country));
  const reach = (from: EventPlace, to: EventPlace) => from.precision === 'country'
    ? countryDistanceKm(from.country, to.latitude, to.longitude)
    : distanceKm(from.latitude, from.longitude, to.latitude, to.longitude);
  // The nearest scan before (`step` -1) or after another that `holds`.
  const nearest = (list: readonly (Located | null)[], index: number, step: number, holds: (entry: Located | null, at: number) => boolean): Located | null => {
    for (let at = index + step; at >= 0 && at < list.length; at += step) if (holds(list[at]!, at)) return list[at]!;
    return null;
  };
  // A bare airport code ("HKG") is the airport where the parcel's way bears it out: in a country the
  // parcel or the scans around it are in, within 300 km of one of those scans, or on the way between
  // them or on to the destination. Otherwise it is no town nothing confirms either ("CAN" is no Çan in
  // Turkey). A town of 100,000 people keeps its name ("POA" is Poá), and a code that is also a country's,
  // where the parcel is ("CAN" on a parcel to Canada), may mean that country.
  const data = gazetteer();
  const holds = (found: Located | null, at: number) => found !== null && !airportCode(data, locations[at]?.trim() ?? '')
    && (found.text || found.place.precision === 'city');
  const airports = new Map<number, Located | null>();
  locations.forEach((location, index) => {
    const airport = airportCode(data, location?.trim() ?? '');
    const town = looked[index];
    if (!airport || (town?.place.precision === 'city' && (town.thousands ?? 0) >= NAMESAKE_THOUSANDS)) return;
    const before = nearest(looked, index, -1, holds)?.place;
    const after = nearest(looked, index, 1, holds)?.place;
    const around = [before, after].filter((other): other is EventPlace => Boolean(other));
    const countries = [...base, ...around.map((other) => other.country)];
    const country = COUNTRY_CODES.get(airport.code);
    if (country && country !== airport.country && countries.includes(country)) return;
    const found = atAirport(airport, carriers);
    const at = found?.place;
    const onWay = !at ? Infinity : before && after
      ? reach(before, at) + reach(after, at) - distanceKm(before.latitude, before.longitude, after.latitude, after.longitude)
      : before && destinationCountry
        ? reach(before, at) + countryDistanceKm(destinationCountry, at.latitude, at.longitude) - countryDistanceKm(destinationCountry, before.latitude, before.longitude)
        : Infinity;
    if (at && (countries.includes(airport.country) || around.some((other) => reach(other, at) <= AWAY_DETOUR_KM) || onWay <= AIRPORT_DETOUR_KM)) {
      airports.set(index, found);
    } else if (!anchored(town ?? null)) airports.set(index, null);
  });
  const first = looked.map((found, index) => airports.has(index) ? airports.get(index)! : found);
  // The scans a town's name alone places, where the scans around them say it is a namesake.
  const namesakes = (list: readonly (Located | null)[]): Set<number> => {
    const found = new Set<number>();
    const lone = list.flatMap((entry, index) => entry && !anchored(entry) && entry.place.precision === 'city' ? [{ ...entry, index }] : []);
    // A name says where a town is when no other town shares it, or when it is a world city's.
    const known = (entry: { thousands?: number; shared?: boolean }) => !entry.shared || (entry.thousands ?? 0) >= WORLD_CITY_THOUSANDS;
    const judge = (entries: typeof lone, holds: (entry: Located | null, index: number) => boolean) => {
      for (const { place, index, ...entry } of entries) {
        const before = nearest(list, index, -1, holds)?.place;
        const after = nearest(list, index, 1, holds)?.place;
        const around = [before, after].filter((other): other is EventPlace => Boolean(other));
        if (around.some((other) => other.country === place.country)) continue;
        if (before && after) {
          const detour = reach(before, place) + reach(after, place) - distanceKm(before.latitude, before.longitude, after.latitude, after.longitude);
          if (detour > DETOUR_MAX_KM) found.add(index);
        } else if (base.length && !known(entry) && around.every((other) => reach(other, place) > LEAP_MAX_KM)
          && base.every((code) => countryDistanceKm(code, place.latitude, place.longitude) > LEAP_MAX_KM)) {
          found.add(index);
        }
      }
    };
    // Such a town stands among the scans that hold, and the towns around it are judged by it too.
    judge(lone.filter(known), anchored);
    judge(lone.filter((entry) => !known(entry)), (entry, index) => entry !== null
      && (anchored(entry) || (entry.place.precision === 'city' && known(entry) && !found.has(index))));
    return found;
  };
  // A namesake tells its neighbours nothing, and neither does a country guessed from a code nothing backs.
  const doubtful = namesakes(first);
  const telling = (found: Located | null, index: number): boolean =>
    found !== null && !doubtful.has(index) && (found.text || found.place.precision === 'city');
  // A world city, or a town far larger than its namesake, keeps its own place over one in a
  // country the parcel is in when it lies nearer the way between the scans around it:
  // "Warsaw" between Lviv and New York is in Poland.
  const ownPlace = (location: string, found: Located | null, index: number): Located | null => {
    if (!found || found.text || found.place.precision !== 'city') return found;
    const other = (entry: Located | null, at: number) => telling(entry, at) && locations[at]?.trim() !== location.trim();
    const before = nearest(first, index, -1, other)?.place;
    const after = nearest(first, index, 1, other)?.place;
    const alone = before && after ? cachedPlace(location, [], carriers) : null;
    if (!before || !after || !alone || alone.place.precision !== 'city' || alone.place.country === found.place.country) return found;
    const thousands = alone.thousands ?? 0;
    if (thousands < WORLD_CITY_THOUSANDS && (thousands < NAMESAKE_THOUSANDS || thousands < DOMINANT_TIMES * (found.thousands ?? 0))) return found;
    const way = (place: EventPlace) => reach(before, place) + reach(after, place);
    return way(alone.place) < way(found.place) ? alone : found;
  };
  const settled = locations.map((location, index) => {
    if (!location?.trim()) return null;
    if (airports.has(index)) return first[index]!;
    const before = nearest(first, index, -1, telling)?.place.country;
    const after = nearest(first, index, 1, telling)?.place.country;
    const neighbours = [...new Set([before, after].filter((code): code is string => Boolean(code)))];
    if (!neighbours.length || neighbours.every((code) => base.includes(code))) return ownPlace(location, first[index]!, index);
    return ownPlace(location, cachedPlace(location, [...neighbours, ...base.filter((code) => !neighbours.includes(code))], carriers)
      ?? (telling(first[index]!, index) ? first[index]! : null), index);
  });
  // Of towns a country shares a name between, the one nearer the scans around it: "Kennington"
  // among London's scans. With no scan around to tell, none.
  const told = settled.map((found, index) => {
    if (!found?.twins) return found;
    const holds = (entry: Located | null, at: number) => telling(entry, at) && !entry!.twins && entry!.place.precision === 'city';
    const around = [nearest(settled, index, -1, holds)?.place, nearest(settled, index, 1, holds)?.place]
      .filter((other): other is EventPlace => Boolean(other));
    if (!around.length) return null;
    const way = (place: EventPlace) => around.reduce((sum, other) => sum + distanceKm(place.latitude, place.longitude, other.latitude, other.longitude), 0);
    const [place] = [found.place, ...found.twins].sort((left, right) => way(left) - way(right));
    return { ...found, place: place!, twins: undefined };
  });
  // A carrier that states each scan's own offset tells a country's towns of one name apart by it:
  // "Lincoln" at -04:00 is not the city in Nebraska. It does when another of the parcel's towns
  // in that country keeps its own, different offset; one stating a single offset everywhere does not.
  // Where a country's zones follow its states, a town keeps any clock of its state.
  const clocks = times.map(statedClock);
  const keepsClock = (place: EventPlace, clock: { at: number; offset: number }) => {
    const region = townRegion(place);
    return [placeTimeZone(place), ...region ? [regionZone(place.country, region), ...otherRegionZones(place.country, region)] : []]
      .some((zone) => zoneOffset(zone, clock.at) === clock.offset);
  };
  const keeps = (found: Located | null, at: number) => found !== null && found.place.precision === 'city'
    && ZONED_REGIONS.has(found.place.country) && clocks[at] !== null && keepsClock(found.place, clocks[at]!);
  const clocked = told.map((found, index) => {
    const clock = clocks[index];
    if (!found || !clock || found.place.precision !== 'city' || found.place.site || !ZONED_REGIONS.has(found.place.country)
      || keeps(found, index) || !told.some((other, at) => other?.place.country === found.place.country && keeps(other, at)
        && clocks[at]!.offset !== clock.offset)) return found;
    const fits = candidates(data, nameKey(found.place.name), carriers).filter((town) => !town.hub && town.country === found.place.country
      && keepsClock({ ...town, precision: 'city' }, clock));
    const other = (entry: Located | null, at: number) => entry?.place.precision === 'city' && locations[at]?.trim() !== locations[index]?.trim();
    const around = [nearest(told, index, -1, other)?.place, nearest(told, index, 1, other)?.place]
      .filter((place): place is EventPlace => Boolean(place));
    const way = (town: Candidate) => around.length
      ? around.reduce((sum, place) => sum + distanceKm(town.latitude, town.longitude, place.latitude, place.longitude), 0) : -town.thousands;
    const [town] = fits.sort((left, right) => way(left) - way(right));
    if (!town) return found;
    const name = /\p{Ll}/u.test(found.place.name) ? found.place.name : town.name;
    return { ...found, thousands: town.thousands, twins: undefined,
      place: { latitude: round(town.latitude), longitude: round(town.longitude), precision: 'city' as const, country: town.country, name } };
  });
  const dropped = namesakes(clocked);
  const places = locations.map((location, index) => {
    const found = clocked[index];
    if (!found || !location || dropped.has(index)) return null;
    return atPoint(found.place, points[index] ?? pointAt.get(location.trim()));
  });
  if (!stages.length) return places;
  const away = awayScans(places, stages, times);
  return places.map((place, index) => away.has(index) ? null : place);
}
