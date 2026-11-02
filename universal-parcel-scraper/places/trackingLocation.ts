import { townName } from '../core/time/townNames.js';

const regionCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
/** Country codes that are also states or cantons ("Hebron, KY", "Buchs AG"), so a bare one is not a country. */
export const ambiguousAddressCodes: ReadonlySet<string> = new Set('AL AZ AR CA CO DE GA ID IL IN KY LA ME MD MA MN MS MO MT NE NC PA SC SD TN VA AG AI BE BL BS FR GE GL GR LU SG SH SO SZ TG NL NU PE SK YT SA'.split(' '));
// Carrier spellings no region name matches. Display only: Passport evidence
// stays in step with private.passport_country, which Friends stamps use.
const carrierSpellings = new Map([
  ['united states of america', 'US'], ['great britain', 'GB'], ['czech republic', 'CZ'], ['holland', 'NL'],
  ['hong kong', 'HK'], ['macau', 'MO'], ['macao', 'MO'], ['turkey', 'TR'], ['russian federation', 'RU'],
  ['korea', 'KR'], ['republic of korea', 'KR'],
]);
// DHL Express's own country names, after the article and any bracket are dropped.
const dhlSpellings = new Map([
  ['hong kong sar, china', 'HK'], ['macau sar, china', 'MO'], ['macao sar, china', 'MO'], ['china mainland', 'CN'],
  ['china, peoples republic', 'CN'], ["people's republic of china", 'CN'], ['korea, republic of', 'KR'],
  ['ireland, republic of', 'IE'],
]);
// Apple's ICU (Safari, iOS) calls CN "China mainland" in every language; carriers write "China".
const chinaNames = new Map([['en', 'China'], ['de', 'China'], ['fr', 'Chine'], ['it', 'Cina'], ['es', 'China'], ['pt', 'China'], ['pl', 'Chiny'], ['uk', 'Китай']]);
// "Mexico City" is a city, not Mexico followed by one.
const settlementWords = new Set(['city', 'town', 'ville', 'stadt', 'ciudad', 'cidade', 'citta']);
// A US military post office: the Army, Fleet or Diplomatic Post Office ("APO, AE 09001",
// "FPO AP") of the Armed Forces Americas, Europe or Pacific.
const MILITARY_POST_OFFICE = /(?:^|[\s,;|(])[ADF]PO[\s,;]+A[AEP](?:\s+\d{5}(?:-\d{4})?)?$/i;
const normalized = (value: string) => value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
let countryNames: Map<string, string> | undefined;
const displayNames = new Map<string, Intl.DisplayNames>();

function namedCountry(name: string, display: boolean): string | null {
  if (!countryNames) {
    countryNames = new Map([['usa', 'US'], ['uk', 'GB']]);
    // Ukrposhta names countries in Ukrainian ("КИТАЙ", "Україна"), Chinese posts in Chinese ("日本").
    for (const language of ['en', 'de', 'fr', 'it', 'es', 'pt', 'pl', 'uk', 'zh', 'zh-Hant', 'ja']) {
      const names = new Intl.DisplayNames([language], { type: 'region' });
      for (const code of regionCodes) {
        const name = names.of(code) ?? code;
        // A name a large town shares ("Granada") names the town as often as the country.
        if (language === 'en' || !townName(name)) countryNames.set(normalized(name), code);
      }
    }
    for (const name of chinaNames.values()) countryNames.set(normalized(name), 'CN');
  }
  const key = normalized(name);
  const code = countryNames.get(key);
  if (code || !display) return code ?? null;
  const bare = key.replace(/^the /, '');
  return countryNames.get(bare) ?? carrierSpellings.get(bare) ?? null;
}

/**
 * Whether a location is a US military post office ("Fpo, AE", "APO AP 96001").
 * Its base can be anywhere in the region the code names (Europe's also covers
 * Africa, the Middle East and Canada), so it names no country: AE there is not
 * the United Arab Emirates.
 */
export function militaryPostOffice(location: string): boolean {
  return MILITARY_POST_OFFICE.test(location.trim());
}

function fieldCountry(field: string, location: string, display: boolean): string | null {
  if (regionCodes.has(field)) return location === field || !ambiguousAddressCodes.has(field) ? field : null;
  return namedCountry(field, display);
}

/** Passport evidence: only an explicit final country field; never a country inferred from a city. */
export function trackingLocationCountry(location?: string): string | null {
  const text = location?.trim();
  const field = text?.split(/[,;|()]/).map((value) => value.trim()).filter(Boolean).at(-1);
  return field && !militaryPostOffice(text!) ? fieldCountry(field, text!, false) : null;
}

export interface TrackingPlace {
  /** The country the carrier wrote, as an ISO 3166-1 alpha-2 code. */
  country: string | null;
  /** The rest of the location; empty when the country was all of it. */
  place: string;
}

/** The country DHL Express ends its locations with: "UK", "NETHERLANDS, THE", "HONG KONG SAR, CHINA". */
function dashCountry(part: string): string | null {
  const name = normalized(part).replace(/\s*\(.*\)$/, '').replace(/^the |, the$/g, '');
  // Also a US state: "ATLANTA - GEORGIA" is not in the Caucasus.
  if (name === 'georgia') return null;
  return dhlSpellings.get(name) ?? namedCountry(name, true);
}

/**
 * For display, take an explicit country off a location: the final field ("Zürich, CH",
 * repeated in "Hebron, KY, US, US"), the name after the last dash ("SCARBOROUGH - ON -
 * CANADA") or a leading name ("Switzerland Haerkingen").
 */
export function trackingPlace(location: string): TrackingPlace {
  const text = location.trim();
  if (militaryPostOffice(text)) return { country: null, place: text };
  const dashed = /^(.*\S)\s+-\s+(.+)$/.exec(text);
  const dashedCountry = dashed ? dashCountry(dashed[2]!) : null;
  if (dashedCountry) return { country: dashedCountry, place: dashed![1]! };
  const fields = [...text.matchAll(/[^,;|()]+/g)].filter((match) => match[0].trim());
  // A code alone between empty fields is alone (",,,DE"). One a state or canton shares is the
  // country another field names, which stays the place: "HOLLAND, NL" is not in Newfoundland,
  // and "Luxembourg, LU" is the city.
  const alone = fields.length === 1 ? fields[0]![0].trim() : text;
  const named = new Set(fields.map((field) => field[0].trim()).filter((field) => !regionCodes.has(field))
    .map((field) => namedCountry(field, true)));
  let country: string | null = null;
  let kept = fields.length;
  while (kept > 0) {
    const field = fields[kept - 1]![0].trim();
    const own = fieldCountry(field, alone, true);
    const code = own ?? (regionCodes.has(field) && named.has(field) ? field : null);
    if (!code || (country && code !== country)) break;
    country = code;
    kept -= 1;
    if (!own) break;
  }
  if (country) return { country, place: kept ? text.slice(0, fields[kept]!.index).replace(/[\s,;|(]+$/u, '') : '' };
  // A partner's depot abroad, by its country and number, as BRT writes one: "SPAIN (12)".
  const depot = /^([^,;|()]+?)\s*\(\d+\)$/u.exec(text);
  const depotCountry = depot ? namedCountry(depot[1]!, true) : null;
  if (depotCountry) return { country: depotCountry, place: '' };
  if (fields.length === 1 && text === fields[0]![0]) {
    // Aggregators can name a DHL country operation instead of a town.
    const operation = /^DHL\s+(.+)$/i.exec(text);
    const operationCountry = operation ? namedCountry(operation[1]!, true) : null;
    if (operationCountry) return { country: operationCountry, place: '' };
    const words = text.split(/\s+/);
    for (let count = Math.min(words.length - 1, 4); count > 0; count -= 1) {
      const code = namedCountry(words.slice(0, count).join(' '), true);
      const place = words.slice(count).join(' ');
      // "Mexico City" and "Panama City FL" are towns; "JAMAICA NY" is in Queens.
      const next = words[count]!;
      if (code && /^\p{Lu}/u.test(place) && !settlementWords.has(normalized(next)) && !/^[A-Z]{2}$/.test(next)) return { country: code, place };
    }
  }
  return { country: null, place: text };
}

export function countryFlag(code: string): string {
  return [...code].map((letter) => String.fromCodePoint(letter.charCodeAt(0) + 127397)).join('');
}

/** The region's name, with the short "Hong Kong" and "Macao" iOS also uses. */
export function countryName(code: string, languageTag: string): string {
  const china = code === 'CN' ? chinaNames.get(languageTag.split('-')[0]!) : undefined;
  if (china) return china;
  const style = code === 'HK' || code === 'MO' ? 'short' : 'long';
  const key = `${languageTag}:${style}`;
  if (!displayNames.has(key)) displayNames.set(key, new Intl.DisplayNames([languageTag], { type: 'region', style }));
  return displayNames.get(key)!.of(code) ?? code;
}
