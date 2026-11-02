import { DateTime } from 'luxon';
import { countryTimeZone, firstOccurrence, settleGuessedClocks, sharedClockZone, townKey, type ParsedTime } from '../../core/time/index.js';

/**
 * MailAmericas' clocks. A scan's `date` and `time` are a wall clock without a
 * zone. The older tracker printed the same wall clocks with an offset that
 * followed the leg: the origin warehouse's scans had the origin country's
 * (China's, mainland Spain's with its summer time), and the scans in the
 * destination country had the destination's, with its summer time: Mexico
 * City's, Santiago's, Bogotá's and Lima's, and Argentina's on an Argentine
 * parcel. It gave Mexico City's to scans in Cancún and Ciudad Juárez too, so
 * a Mexican scan is either on Mexico City's clock or its own town's; the two
 * agree where the recipient's state keeps Mexico City's. Flights, transit
 * hubs, the arrival, label creation, tax ID checks, notices and duty payments
 * had other offsets or none, and El Salvador's scans one that is not El
 * Salvador's.
 */

// Scans in the destination country: customs, the intermediate warehouse, the
// last-mile provider's offices and the delivery. A duty recorded as paid
// (AD-4) had China's offset on a parcel for Mexico.
const DESTINATION_LEG = /^(?:AD-(?!4$)|WI-|RC-|LM-|PF-)\d+$/;
// The origin warehouse.
const ORIGIN_LEG = /^WH-\d+$/;

const MEXICO_CITY = 'America/Mexico_City';
const CENTRAL = [MEXICO_CITY];
// Durango, and Coahuila, Nuevo León and Tamaulipas, whose border towns keep
// the United States' summer time.
const NORTHEAST = ['America/Monterrey', 'America/Matamoros'];
// Mexico's states as the reply names them, with the zones their towns keep.
const MEXICO_STATE_ZONES: Readonly<Record<string, readonly string[]>> = {
  aguascalientes: CENTRAL, bajacalifornia: ['America/Tijuana'], bajacaliforniasur: ['America/Mazatlan'],
  campeche: ['America/Merida'], chiapas: CENTRAL,
  chihuahua: ['America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga'],
  ciudaddemexico: CENTRAL, cdmx: CENTRAL, distritofederal: CENTRAL, coahuila: NORTHEAST, coahuiladezaragoza: NORTHEAST,
  colima: CENTRAL, durango: ['America/Monterrey'], guanajuato: CENTRAL, guerrero: CENTRAL, hidalgo: CENTRAL, jalisco: CENTRAL,
  mexico: CENTRAL, estadodemexico: CENTRAL, michoacan: CENTRAL, michoacandeocampo: CENTRAL, morelos: CENTRAL,
  nayarit: ['America/Mazatlan', 'America/Bahia_Banderas'], nuevoleon: NORTHEAST, oaxaca: CENTRAL, puebla: CENTRAL,
  queretaro: CENTRAL, queretarodearteaga: CENTRAL, quintanaroo: ['America/Cancun'], sanluispotosi: CENTRAL,
  sinaloa: ['America/Mazatlan'], sonora: ['America/Hermosillo'], tabasco: CENTRAL, tamaulipas: NORTHEAST, tlaxcala: CENTRAL,
  veracruz: CENTRAL, veracruzdeignaciodelallave: CENTRAL, yucatan: ['America/Merida'], zacatecas: CENTRAL,
};
const MEXICO_STATES: Readonly<Record<string, readonly string[]>> = {
  ...MEXICO_STATE_ZONES,
  // The customary abbreviations the reply can give instead: "JAL." for Jalisco.
  ...Object.fromEntries(Object.entries({
    ags: 'aguascalientes', bc: 'bajacalifornia', bcs: 'bajacaliforniasur', camp: 'campeche', chis: 'chiapas', chih: 'chihuahua',
    coah: 'coahuila', col: 'colima', df: 'distritofederal', dgo: 'durango', gto: 'guanajuato', gro: 'guerrero', hgo: 'hidalgo',
    jal: 'jalisco', mex: 'mexico', edomex: 'mexico', mich: 'michoacan', mor: 'morelos', nay: 'nayarit', nl: 'nuevoleon',
    oax: 'oaxaca', pue: 'puebla', qro: 'queretaro', qroo: 'quintanaroo', slp: 'sanluispotosi', sin: 'sinaloa', son: 'sonora',
    tab: 'tabasco', tamps: 'tamaulipas', tlax: 'tlaxcala', ver: 'veracruz', yuc: 'yucatan', zac: 'zacatecas',
  }).map(([short, state]) => [short, MEXICO_STATE_ZONES[state]!])),
};

const SANTIAGO = 'America/Santiago';
const MAINLAND = [SANTIAGO];
const MAGALLANES = ['America/Punta_Arenas'];
// Chile's regions as the reply names them. Easter Island belongs to Valparaíso.
const CHILE_REGIONS: Readonly<Record<string, readonly string[]>> = {
  aricayparinacota: MAINLAND, tarapaca: MAINLAND, antofagasta: MAINLAND, atacama: MAINLAND, coquimbo: MAINLAND,
  valparaiso: [SANTIAGO, 'Pacific/Easter'], metropolitana: MAINLAND, metropolitanadesantiago: MAINLAND, santiago: MAINLAND,
  ohiggins: MAINLAND, libertadorgeneralbernardoohiggins: MAINLAND, maule: MAINLAND, nuble: MAINLAND, biobio: MAINLAND,
  araucania: MAINLAND, laaraucania: MAINLAND, losrios: MAINLAND, loslagos: MAINLAND, aysen: MAINLAND,
  aysendelgeneralcarlosibanezdelcampo: MAINLAND, magallanes: MAGALLANES, magallanesylaantarticachilena: MAGALLANES,
};

// Every Argentine zone keeps the same clock.
const ARGENTINA = ['Buenos_Aires', 'Catamarca', 'Cordoba', 'Jujuy', 'La_Rioja', 'Mendoza', 'Rio_Gallegos', 'Salta',
  'San_Juan', 'San_Luis', 'Tucuman', 'Ushuaia'].map((zone) => `America/Argentina/${zone}`);

/** A state or region named with or without "Región de" or "Región del". */
function regionZones(table: Readonly<Record<string, readonly string[]>>, name: string): readonly string[] | null {
  const key = townKey(name);
  const named = [key, ...['region', 'regionde', 'regiondel'].map((prefix) => key.startsWith(prefix) ? key.slice(prefix.length) : '')]
    .find((candidate) => candidate && Object.hasOwn(table, candidate));
  return named ? table[named]! : null;
}

/**
 * The zones a destination's scans may keep, the older tracker's first, or
 * null where its clock cannot be placed.
 */
function destinationZones(country: string, region: string): readonly string[] | null {
  const within = (zone: string, zones: readonly string[] | null) => zones ? [zone, ...zones] : null;
  switch (country) {
    case 'AR': return ARGENTINA;
    case 'CO': return ['America/Bogota'];
    case 'PE': return ['America/Lima'];
    case 'MX': return within(MEXICO_CITY, regionZones(MEXICO_STATES, region));
    case 'CL': return within(SANTIAGO, regionZones(CHILE_REGIONS, region));
    default: return null;
  }
}

/**
 * A wall clock read where every zone keeps the same clock; null where they
 * differ, or for a time the clocks skip or repeat.
 */
function wallIn(wall: string, zones: readonly string[] | null): ParsedTime | null {
  const zone = zones ? sharedClockZone(zones, wall) : null;
  if (!zone) return null;
  const read = firstOccurrence(DateTime.fromISO(wall, { zone }));
  if (!read.isValid || read.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || read.getPossibleOffsets().length !== 1) return null;
  const iso = read.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: read.toMillis() } : null;
}

/** Where a parcel comes from and goes to, as ISO codes, and the recipient's state or region. */
export interface MailamericasRoute {
  origin: string | null;
  destination: string | null;
  region: string;
}

/**
 * Each scan's instant, given newest first with its wall clock and code, or
 * null where its clock stays local. A destination scan's stands unless it is
 * after the lookup; an origin warehouse scan's must also keep the feed's
 * order against the dated destination scans.
 */
export function mailamericasInstants(scans: readonly { wall: string; code: string }[], route: MailamericasRoute, readAt: number): (ParsedTime | null)[] {
  const destination = route.destination ? destinationZones(route.destination, route.region) : null;
  // An origin that is the destination does not say where the warehouse is.
  const origin = route.origin && route.origin !== route.destination ? countryTimeZone(route.origin) : null;
  const arrived = settleGuessedClocks(scans.map((scan) => ({
    guesses: [DESTINATION_LEG.test(scan.code) ? wallIn(scan.wall, destination) : null],
  })), readAt);
  return settleGuessedClocks(scans.map((scan, index) => ({
    known: arrived[index],
    guesses: [ORIGIN_LEG.test(scan.code) && origin ? wallIn(scan.wall, [origin]) : null],
  })), readAt);
}
