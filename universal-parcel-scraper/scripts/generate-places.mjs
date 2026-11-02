// Builds places/places.tsv.br, the offline gazetteer that turns the
// free-text locations carriers print into map places.
//
// Sources, downloaded into a cache directory on the first run:
// - GeoNames cities1000, first-level regions, postal codes, some countries' full dumps
//   for their municipalities, and names by language, CC BY 4.0: https://www.geonames.org
// - OurAirports airports, public domain: https://ourairports.com/data/
// - Country label points from places/countries.json (Natural Earth, public domain)
//
// Run: node scripts/generate-places.mjs [cache directory]. Needs `unzip`.
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { nameKey, nameKeys } from '../places/names.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.argv[2] ?? '/tmp/universal-parcel-scraper-places';
const output = join(root, 'places/places.tsv.br');
// Small towns in these countries often host sorting centres, so every
// locality in their postal files becomes a place. Belgian municipalities
// ("Grâce-Hollogne", by Liège airport) are not GeoNames towns at all, and US
// distribution centres go by a post office's name ("Sparrows Point, MD").
const LOCALITY_COUNTRIES = ['CH', 'LI', 'AT', 'DE', 'FR', 'IT', 'BE', 'LU', 'NL', 'US'];
// Only these carriers print postcodes ("Härkingen 4622").
const POSTCODE_COUNTRIES = new Set(['CH', 'LI']);
// Exonyms and translations ("Genf", "Cologne") matter for towns, not hamlets,
// and for smaller towns only where they have several official names.
const ALTERNATES_FROM = 50_000;
const BILINGUAL_FROM = 10_000;
const MULTILINGUAL = new Set(['CH', 'LI', 'AT', 'DE', 'FR', 'IT', 'BE', 'LU', 'NL']);
// Chinese, Japanese and Korean carriers print towns in their own script ("深圳市").
const CJK_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW', 'JP', 'KR']);
const CHINESE_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW']);
// So do carriers in countries written in Cyrillic ("Тюмень").
const CYRILLIC_COUNTRIES = new Set(['RU', 'BY', 'UA', 'KZ', 'KG', 'TJ', 'MN', 'BG', 'RS', 'MK']);
const SKIPPED_FEATURES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
// Chinese carriers lead with the province ("广东省深圳市"); GeoNames names them only in English.
const CHINESE_PROVINCES = {
  '01': '安徽', '02': '浙江', '03': '江西', '04': '江苏', '05': '吉林', '06': '青海', '07': '福建', '08': '黑龙江', '09': '河南',
  10: '河北', 11: '湖南', 12: '湖北', 13: '新疆', 14: '西藏', 15: '甘肃', 16: '广西', 18: '贵州', 19: '辽宁', 20: '内蒙古',
  21: '宁夏', 22: '北京', 23: '上海', 24: '山西', 25: '山东', 26: '陕西', 28: '天津', 29: '云南', 30: '广东', 31: '海南',
  32: '四川', 33: '重庆',
};
// Municipalities of 1,000 people or more that no town of the gazetteer is named after, by the
// level each country keeps them at in its full GeoNames dump: "Kabelsketal" is a municipality
// of villages by Leipzig, and Portuguese carriers still name the parishes merged in 2013.
// Taiwan's towns are its districts and townships.
const DIVISIONS = {
  AT: ['ADM3'], CH: ['ADM3'], DE: ['ADM4'], ES: ['ADM3'], FR: ['ADM4'], IT: ['ADM3'], NL: ['ADM2'], PL: ['ADM3'],
  NO: ['ADM2'], PT: ['ADM3', 'ADM3H'], TW: ['ADM3'],
};
const DIVISION_FROM = 1_000;
// Towns (镇) and townships (乡) by their seats, in the Chinese provinces most cross-border parcels
// leave from, Guangdong and Zhejiang: "麻涌镇", "Mayong Town". All of China's would be 12,000 places.
const TOWNSHIPS = { CN: ['30', '02'] };
// The words Chinese and Japanese close a division's name with: "蘆竹區" is Luzhu.
const CJK_DIVISION = /[省市区县縣區镇鎮乡鄉]$/u;
// Names carriers still print that GeoNames gives in English or as renamed: Mexico City was
// the Distrito Federal until 2016, and Brasília's is the Distrito Federal of Brazil.
const REGION_ALIASES = { 'MX.09': ['distrito federal'], 'BR.07': ['distrito federal'] };
// What a region's name adds to the place it names: "Inner Mongolia Autonomous Region", "Gyeonggi-do".
const REGION_WORDS = /\s+(autonomous region|special administrative region|region|province|prefecture|voivodeship|oblast|do)$/;
// Without those words, some names are only a direction or a common word ("Central Region", "Capital Region").
const GENERIC_REGIONS = new Set('central capital north south east west northern southern eastern western upper lower greater middle coast islands'.split(' '));

async function download(file, url) {
  const path = join(cache, file);
  try {
    await access(path);
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await mkdir(cache, { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

const unzip = (zip, entry) => execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
const lines = (text) => text.split('\n').filter(Boolean).map((line) => line.split('\t'));
// About 100 m: plenty for a dot on a city.
const round = (value) => Math.round(Number(value) * 1e3) / 1e3;
const latin = (name) => /^[\p{Script=Latin} '’.\-()]{3,40}$/u.test(name) && !/^[A-Z]{2,5}$/.test(name);
const cjk = (name) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,12}$/u.test(name);
const cyrillic = (name) => /^[\p{Script=Cyrillic} '’.\-()]{3,40}$/u.test(name);

const alternatesFrom = (country) => (MULTILINGUAL.has(country) ? BILINGUAL_FROM : ALTERNATES_FROM);

/**
 * A town's other names, as keys its own names lack: those GeoNames gives it in a language carriers
 * print. GeoNames also spells each name in another script in Latin letters, in lower case when it
 * reads Chinese characters in Chinese. That is how Chinese carriers spell their own towns ("shen
 * zhen"), but no name elsewhere: "Membris" is Mömbris in Russian, "noman" Norman in Japanese.
 */
function alternateKeys(id, alternates, country, population, primary) {
  const keys = new Set();
  if (Number(population) < alternatesFrom(country)) return keys;
  const printed = printedNames.get(id);
  for (const other of alternates.split(',')) {
    if (latin(other) && other === other.toLowerCase() ? !CHINESE_COUNTRIES.has(country)
      : !printed?.has(other) || !(latin(other) || CJK_COUNTRIES.has(country) && cjk(other) || CYRILLIC_COUNTRIES.has(country) && cyrillic(other))) continue;
    // Three Latin letters are a code or a stray transliteration more often
    // than a name ("lon" for Lognes, "chi" for Jizhou), and carriers print
    // them for other towns.
    for (const key of nameKeys(other)) if (!primary.has(key) && (key.length > 3 || cjk(key) || cyrillic(key))) keys.add(key);
  }
  return keys;
}

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** RFC 4180 rows: quoted fields may hold commas and doubled quotes. */
function csv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      rows.push([...row, field.replace(/\r$/, '')]);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

const cities = lines(unzip(await download('cities1000.zip', 'https://download.geonames.org/export/dump/cities1000.zip'), 'cities1000.txt'));
// The rows of the full dumps the gazetteer reads: regions, divisions and township seats.
const dumps = new Map();
for (const country of [...new Set([...Object.keys(DIVISIONS), ...Object.keys(TOWNSHIPS)])].sort()) {
  const levels = new Set(DIVISIONS[country] ?? []);
  const townships = new Set(TOWNSHIPS[country] ?? []);
  const dump = unzip(await download(`dump-${country}.zip`, `https://download.geonames.org/export/dump/${country}.zip`), `${country}.txt`);
  dumps.set(country, lines(dump).filter(([, , , , , , featureClass, feature, , , admin1]) => featureClass === 'A' && (feature === 'ADM1' || levels.has(feature))
    || featureClass === 'P' && feature === 'PPLA4' && townships.has(admin1)));
}

// Carriers print a town in its country's languages, in English or by its local abbreviation
// ("HCM City"), and carriers of the largest markets a foreign one in their own ("Londres",
// "Francoforte"). GeoNames names large towns in every language an encyclopedia has, and those
// names can be another language's word: "Pastas", Pasto in Lithuanian, is the Lithuanian for post.
// Names without a language are local, historic or older romanizations ("Ta-yuan").
const PRINTED_LANGUAGES = ['', 'en', 'abbr', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt'];
const countryLanguages = new Map(lines(await readFile(await download('countryInfo.txt', 'https://download.geonames.org/export/dump/countryInfo.txt'), 'utf8'))
  .filter(([code]) => !code.startsWith('#'))
  .map(([code, , , , , , , , , , , , , , , languages]) => [code, new Set([...PRINTED_LANGUAGES, ...languages.split(',').map((language) => language.split('-')[0])])]));
// The languages carriers print, for each place large enough for other names.
const printedLanguages = new Map([...cities, ...[...dumps.values()].flat()]
  .filter(([, , , , , , , , country, , , , , , population]) => Number(population) >= alternatesFrom(country))
  .map(([id, , , , , , , , country]) => [id, countryLanguages.get(country) ?? new Set(PRINTED_LANGUAGES)]));
const printedNames = new Map();
const alternateNames = spawn('unzip', ['-p', await download('alternateNamesV2.zip', 'https://download.geonames.org/export/dump/alternateNamesV2.zip'), 'alternateNamesV2.txt']);
for await (const line of createInterface({ input: alternateNames.stdout, crlfDelay: Infinity })) {
  const [, id, language, name] = line.split('\t');
  if (!printedLanguages.get(id)?.has(language.split('-')[0])) continue;
  printedNames.set(id, (printedNames.get(id) ?? new Set()).add(name));
}

const places = [];
const byKey = new Map();
// Spanish carriers leave out the article a town's name begins with: "BORGES DEL CAMP" is les
// Borges del Camp, "Garriga,La" La Garriga.
const SPANISH_ARTICLE = /^(?:el|la|los|las|els|les|l|sa|ses|es|s) (.{4,})$/;
/**
 * Other spellings of a town's own name that carriers use: Greek ones write χ as "ch" ("VRACHATI"),
 * GeoNames "kh", and German ones leave out the kind of municipality GeoNames can end a name with
 * ("Freiburg (Elbe) Flecken").
 */
function spellings(place) {
  if (place.country === 'ES') return place.primary.flatMap((key) => SPANISH_ARTICLE.exec(key)?.[1] ?? []);
  if (place.country === 'GR') return place.primary.filter((key) => key.includes('kh')).map((key) => key.replaceAll('kh', 'ch'));
  if (place.country === 'DE') return place.primary.flatMap((key) => /^(.+) flecken$/.exec(key)?.[1] ?? []);
  return [];
}
function remember(place) {
  for (const key of spellings(place)) if (!place.primary.includes(key) && !place.alternate.includes(key)) place.alternate.push(key);
  places.push(place);
  for (const key of place.primary) {
    const list = byKey.get(`${place.country}:${key}`) ?? [];
    list.push(place);
    byKey.set(`${place.country}:${key}`, list);
  }
}

for (const [id, name, ascii, alternates, lat, lon, featureClass, feature, country, , admin1, admin2, , , population] of cities) {
  if (featureClass !== 'P' || SKIPPED_FEATURES.has(feature)) continue;
  const primary = new Set([...nameKeys(name), ...nameKeys(ascii)]);
  const alternate = alternateKeys(id, alternates, country, population, primary);
  remember({
    name, ascii, country, admin1, admin2: country === 'FR' || country === 'IT' ? admin2 : '', lat: round(lat), lon: round(lon),
    population: Number(population) || 0, primary: [...primary], alternate: [...alternate],
  });
}
const listed = places.length;

// Postal files: every locality, and for CH and LI every postcode.
const postcodes = new Map();
for (const country of LOCALITY_COUNTRIES) {
  const rows = lines(unzip(await download(`${country}.zip`, `https://download.geonames.org/export/zip/${country}.zip`), `${country}.txt`));
  for (const [, code, rawName, , admin1, , admin2, , , lat, lon, accuracy] of rows) {
    // "Buchs SG 1" and "Paris 01" are postal subdivisions of "Buchs" and "Paris".
    const name = rawName.replace(/(\s+(\d+|[A-Z]{2}|SC|PF))+$/u, '').trim();
    const point = [round(lat), round(lon)];
    if (POSTCODE_COUNTRIES.has(country) && !postcodes.has(`${country}:${code}`)) {
      postcodes.set(`${country}:${code}`, { country, code, name, lat: point[0], lon: point[1] });
    }
    // Rows without an accuracy are companies and post boxes, not places.
    if (!accuracy || !latin(name)) continue;
    const keys = nameKeys(name);
    const known = keys.some((key) => (byKey.get(`${country}:${key}`) ?? [])
      .some((place) => distanceKm(point, [place.lat, place.lon]) < 15));
    if (known) continue;
    remember({
      name, ascii: name, country, admin1, admin2: country === 'FR' || country === 'IT' ? admin2 : '', lat: point[0], lon: point[1],
      population: 0, primary: keys, alternate: [],
    });
  }
}

/**
 * A division's name as a town's: "Gemeente Best" is Best, "Pfeffenhausen, Markt" Pfeffenhausen,
 * "Adrada, La" La Adrada, "Yingge District" Yingge. A union of parishes and Vienna's districts
 * name no town.
 */
function divisionName(name) {
  if (/^(Uni[ãa]o das freguesias|Gemeindebezirk)\b/iu.test(name)) return null;
  const bare = name.replace(/^(Gemeente|Gmina)\s+/u, '');
  const article = /^(.+),\s*(El|La|Los|Las|Els|Les|A|As|O|Os|Sa|Ses|Es|L')$/u.exec(bare);
  if (article) return article[2].endsWith("'") ? `${article[2]}${article[1]}` : `${article[2]} ${article[1]}`;
  return bare.replace(/,.*$/u, '')
    .replace(/\s+(Mountain Indigenous (District|Township)|Urban Township|Rural Township|District|Township|City)$/u, '').trim();
}

/** A name's Chinese or Japanese forms, with and without the word for its division ("蘆竹區", "蘆竹"). */
function cjkNames(alternates) {
  const names = new Set();
  for (const other of alternates.split(',')) {
    if (!cjk(other)) continue;
    names.add(other);
    const bare = other.replace(CJK_DIVISION, '');
    if (bare.length >= 2) names.add(bare);
  }
  return names;
}

// Places by any of their names, as the divisions are added.
const byName = new Map();
function addNames(place) {
  for (const key of new Set([...place.primary, ...place.alternate])) {
    byName.set(`${place.country}:${key}`, [...byName.get(`${place.country}:${key}`) ?? [], place]);
  }
}
for (const place of places) addNames(place);
const byWord = new Map();
for (const place of places) {
  for (const key of place.primary) {
    const word = `${place.country}:${key.split(' ')[0]}`;
    byWord.set(word, [...byWord.get(word) ?? [], place]);
  }
}
/**
 * A place already known by a name within `km`, by another of its names ("Seville" is Sevilla), or
 * spelling out what a division abbreviates ("Kirchheim b.München" is Kirchheim bei München).
 * A division's point can lie further from its town's: a place of its name and region with as many
 * people, give or take half, is the same ("Andújar").
 */
function knownPlace(country, name, point, km, division) {
  const keys = nameKeys(name);
  const base = nameKey(name.replace(/\s*\(.*$/u, '').replace(/\s+\p{Ll}{1,3}\.\s*.*$/u, ''));
  const near = (place) => distanceKm(point, [place.lat, place.lon]) < km;
  const same = (place) => near(place) || (division !== undefined && place.admin1 === division.admin1
    && distanceKm(point, [place.lat, place.lon]) < 100 && Math.max(place.population, division.population) <= 2 * Math.min(place.population, division.population));
  return keys.flatMap((key) => byName.get(`${country}:${key}`) ?? []).find(same)
    ?? (base ? [...byKey.get(`${country}:${base}`) ?? [], ...(byWord.get(`${country}:${base.split(' ')[0]}`) ?? [])
      .filter((place) => place.primary.some((key) => key === base || key.startsWith(`${base} `)))].find(near) : undefined);
}

// First-level regions by the name GeoNames gives them in their country's dump, which is often
// the local one carriers print: "Catalunya", "Lombardia", "Steiermark".
const regionLocalNames = new Map();
for (const [country, rows] of dumps) {
  const levels = new Set(DIVISIONS[country] ?? []);
  const townships = new Set(TOWNSHIPS[country] ?? []);
  for (const [id, rawName, ascii, alternates, lat, lon, featureClass, feature, , , admin1, admin2, , , population] of rows) {
    if (featureClass === 'A' && feature === 'ADM1') regionLocalNames.set(`${country}.${admin1}`, [rawName, ascii]);
    const division = featureClass === 'A' && levels.has(feature) && Number(population) >= DIVISION_FROM;
    const seat = townships.has(admin1) && featureClass === 'P' && feature === 'PPLA4';
    if (!division && !seat) continue;
    const name = division ? divisionName(rawName) : rawName;
    if (!name || !latin(name)) continue;
    const point = [round(lat), round(lon)];
    const plain = division ? divisionName(ascii) ?? name : ascii;
    const primary = new Set([...nameKeys(name), ...nameKeys(plain)]);
    // Its Chinese name, which a town too small for translations lacks, and the other names of a
    // division with as many people as a town that has them: Taiwan's are older romanizations
    // ("Ta-yuan" is Dayuan).
    const names = new Set([...CJK_COUNTRIES.has(country) ? cjkNames(alternates) : [], ...alternateKeys(id, alternates, country, population, primary)]);
    const town = knownPlace(country, name, point, seat ? 5 : 15, division ? { admin1, population: Number(population) } : undefined);
    if (town) {
      for (const other of names) if (!town.primary.includes(other) && !town.alternate.includes(other)) town.alternate.push(other);
      continue;
    }
    const place = {
      name, ascii: plain, country, admin1, admin2: country === 'FR' || country === 'IT' ? admin2 : '', lat: point[0], lon: point[1],
      population: Number(population) || 0, primary: [...primary], alternate: [...names],
    };
    remember(place);
    addNames(place);
  }
}

// Mexican carriers print a municipality's name for its seat when the two differ: "Cajeme" is
// Ciudad Obregón's, "Corregidora" El Pueblito's. A name another place or municipality has names
// none ("Benito Juárez", "Tlaxcala").
const SEAT_COUNTRIES = ['MX'];
for (const country of SEAT_COUNTRIES) {
  const municipalities = new Map();
  const seats = new Map();
  const dump = unzip(await download(`dump-${country}.zip`, `https://download.geonames.org/export/dump/${country}.zip`), `${country}.txt`);
  for (const [, rawName, ascii, , lat, lon, featureClass, feature, , , admin1, admin2] of lines(dump)) {
    const code = `${admin1}.${admin2}`;
    if (featureClass === 'A' && feature === 'ADM2') municipalities.set(code, [rawName, ascii]);
    else if (featureClass === 'P' && feature === 'PPLA2') seats.set(code, [rawName, [round(lat), round(lon)]]);
  }
  const named = new Map();
  for (const [code, names] of municipalities) {
    const keys = new Set(names.flatMap((name) => nameKeys(name.replace(/\s+municipality$/iu, '').replace(/\s*-Dto\..*$/u, ''))));
    municipalities.set(code, keys);
    for (const key of keys) named.set(key, (named.get(key) ?? 0) + 1);
  }
  for (const [code, keys] of municipalities) {
    const seat = seats.get(code);
    const town = seat && knownPlace(country, seat[0], seat[1], 5);
    if (!town) continue;
    for (const key of keys) {
      if (named.get(key) !== 1 || byName.has(`${country}:${key}`)) continue;
      town.alternate.push(key);
      byName.set(`${country}:${key}`, [town]);
    }
  }
}

// Chinese cities by their pinyin name with the word for city (市, "shi") joined to it, as SpeedPAK
// prints them: "shenzhenshi". Not a name another place has: Huangshi and Shishi are cities of their own.
const CITY_SUFFIX_FROM = 100_000;
for (const place of places) {
  if (place.country !== 'CN' || place.population < CITY_SUFFIX_FROM) continue;
  for (const key of place.primary) {
    const joined = `${key}shi`;
    if (key.includes(' ') || byName.has(`CN:${joined}`)) continue;
    place.alternate.push(joined);
    byName.set(`CN:${joined}`, [place]);
  }
}

const admin1Codes = lines(await readFile(await download('admin1CodesASCII.txt', 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'), 'utf8'));

// Canada Post still addresses mail to the cities Toronto absorbed ("SCARBOROUGH -
// ON - CANADA"); GeoNames lists them as divisions, not towns. The Canadian postal
// file has one row per urban postal area, named after its municipality first
// ("Scarborough (Agincourt)"); a rural area, with a 0 second, names a region
// ("Eastern Alberta (St. Paul)"). A municipality is placed at the mean of its areas.
const provinces = new Map(admin1Codes.filter(([id]) => id.startsWith('CA.')).map(([id, name]) => [nameKey(name), id.slice(3)]));
const municipalities = new Map();
for (const [, code, area, province, , municipality, , , , lat, lon] of lines(unzip(await download('CA.zip', 'https://download.geonames.org/export/zip/CA.zip'), 'CA.txt'))) {
  const name = area.replace(/\s*\(.*$/u, '').trim();
  if (code[1] === '0' || name !== municipality.trim() || !latin(name) || !provinces.has(nameKey(province))) continue;
  const key = `${provinces.get(nameKey(province))}:${name}`;
  municipalities.set(key, [...municipalities.get(key) ?? [], [Number(lat), Number(lon)]]);
}
for (const [key, points] of municipalities) {
  const [admin1, name] = key.split(/:(.*)/u);
  const point = [round(points.reduce((sum, [lat]) => sum + lat, 0) / points.length), round(points.reduce((sum, [, lon]) => sum + lon, 0) / points.length)];
  const keys = nameKeys(name);
  if (keys.some((other) => (byKey.get(`CA:${other}`) ?? []).some((place) => distanceKm(point, [place.lat, place.lon]) < 15))) continue;
  remember({ name, ascii: name, country: 'CA', admin1, admin2: '', lat: point[0], lon: point[1], population: 0, primary: keys, alternate: [] });
}

// First-level regions by name ("Ontario", "Virginia", "Guangdong"): scans name
// them after the town, and they tell towns of one name apart.
const regions = [];
for (const [id, name, ascii] of admin1Codes) {
  const [country, admin1] = id.split('.');
  const keys = new Set([name, ascii, ...regionLocalNames.get(id) ?? []].flatMap(nameKeys));
  for (const key of [...keys]) if (!GENERIC_REGIONS.has(key.replace(REGION_WORDS, ''))) keys.add(key.replace(REGION_WORDS, ''));
  if (country === 'CN' && CHINESE_PROVINCES[admin1]) keys.add(CHINESE_PROVINCES[admin1]);
  for (const alias of REGION_ALIASES[id] ?? []) keys.add(alias);
  regions.push({ country, admin1, keys: [...keys].filter((key) => key.length >= 2) });
}

// Airports with scheduled flights, for scans that name one ("Frankfurt Airport (FRA)").
const airports = csv(await readFile(await download('airports.csv', 'https://davidmegginson.github.io/ourairports-data/airports.csv'), 'utf8'))
  .filter((airport) => ['large_airport', 'medium_airport'].includes(airport.type) && airport.scheduled_service === 'yes'
    && /^[A-Z]{3}$/.test(airport.iata_code) && airport.iso_country)
  .map((airport) => [airport.iata_code, airport.iso_country, round(airport.latitude_deg), round(airport.longitude_deg),
    airport.name.trim(), airport.municipality.trim()])
  .sort(([a], [b]) => a.localeCompare(b));

const world = JSON.parse(await readFile(join(root, 'places/countries.json'), 'utf8'));
const countries = world.countries.filter((country) => country.code && country.label)
  .map((country) => [country.code, country.name, country.label[0], country.label[1]])
  .sort(([a], [b]) => a.localeCompare(b));

places.sort((a, b) => a.country.localeCompare(b.country) || nameKey(a.name).localeCompare(nameKey(b.name)) || a.lat - b.lat || a.lon - b.lon);
regions.sort((a, b) => a.country.localeCompare(b.country) || a.admin1.localeCompare(b.admin1));
const text = [
  '# Places for carrier scan locations. Generated by scripts/generate-places.mjs.',
  '# GeoNames (https://www.geonames.org), CC BY 4.0. Country points: Natural Earth, public domain. Airports: OurAirports, public domain.',
  ...countries.map((country) => ['C', ...country].join('\t')),
  ...regions.map((region) => ['R', region.country, region.admin1, region.keys.join(',')].join('\t')),
  ...airports.map((airport) => ['A', ...airport].join('\t')),
  // Primary keys are recomputed from the names when the file is read, and
  // population in thousands is all the ranking needs.
  ...places.map((place) => ['P', place.name, nameKey(place.ascii) === nameKey(place.name) ? '' : place.ascii, place.country,
    place.admin1, place.admin2, place.lat, place.lon, Math.round(place.population / 1000), place.alternate.join(',')].join('\t')),
  ...[...postcodes.values()].sort((a, b) => a.country.localeCompare(b.country) || a.code.localeCompare(b.code))
    .map((entry) => ['Z', entry.country, entry.code, entry.lat, entry.lon, entry.name].join('\t')),
].join('\n');
const compressed = brotliCompressSync(text, { params: {
  [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: text.length,
} });
await writeFile(output, compressed);
console.log(`places.tsv.br: ${countries.length} countries, ${regions.length} regions, ${airports.length} airports, ${listed} GeoNames places, `
  + `${places.length - listed} other localities, ${postcodes.size} postcodes, ${Math.round(text.length / 1024)} KB, `
  + `${Math.round(compressed.length / 1024)} KB compressed`);
