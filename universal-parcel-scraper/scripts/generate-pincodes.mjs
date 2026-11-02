// Builds places/pincodes.json: the town each Indian PIN code is in, for India Post
// scans that name their office only by an abbreviation and its PIN ("KOL AP TMO 700052").
//
// Sources:
// - All India Pincode Directory, Department of Posts, Ministry of Communications,
//   https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month,
//   Government Open Data License - India: https://www.data.gov.in/Godl.
//   Download its CSV (circlename, …, officename, pincode, officetype, delivery, district,
//   statename, latitude, longitude) and pass its path.
// - GeoNames cities1000, CC BY 4.0, from the cache scripts/generate-places.mjs fills.
//
// Run: node scripts/generate-pincodes.mjs <directory.csv> [cache directory]. Needs `unzip`.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [directory, cache = '/tmp/universal-parcel-scraper-places'] = process.argv.slice(2);
if (!directory) throw new Error('usage: node scripts/generate-pincodes.mjs <directory.csv> [cache directory]');
// A PIN is placed at a town of this many people…
const MIN_POPULATION = 50_000;
// …within this distance of its offices: past it, the PIN gets no place.
const MAX_KM = 25;
// Bigger towns win over nearer ones, a tenfold population for every 5 km:
// the Kolkata GPO is in Kolkata, not one of the towns around it.
const KM_PER_DECADE = 5;
// Offices this far from the median of their sorting district (the first three
// digits) have wrong coordinates in the directory.
const OUTLIER_KM = 100;

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
  const names = header.map((name) => name.trim().toLowerCase());
  return body.map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ''])));
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const middle = (points) => [median(points.map(([lat]) => lat)), median(points.map(([, lon]) => lon))];

// Offices with coordinates in India, by PIN. PINs starting with 9 are the Army Postal Service.
// A PIN's head office, or else its delivery offices, say where it is: the coordinates of
// non-delivery offices are often wrong (half of those of the Kolkata GPO's PIN are 30 km off).
const offices = new Map();
const rank = (office) => office.officetype === 'HO' ? 0 : office.delivery === 'Delivery' ? 1 : 2;
for (const office of csv(await readFile(directory, 'utf8'))) {
  const point = [Number(office.latitude), Number(office.longitude)];
  if (!/^[1-8]\d{5}$/.test(office.pincode) || !(point[0] > 6 && point[0] < 37.5 && point[1] > 68 && point[1] < 98)) continue;
  const known = offices.get(office.pincode);
  if (!known || rank(office) < known.rank) offices.set(office.pincode, { rank: rank(office), points: [point] });
  else if (rank(office) === known.rank) known.points.push(point);
}
for (const [pin, { points }] of offices) offices.set(pin, points);
const districts = new Map();
for (const [pin, points] of offices) districts.set(pin.slice(0, 3), [...districts.get(pin.slice(0, 3)) ?? [], ...points]);
const districtMiddle = new Map([...districts].map(([prefix, points]) => [prefix, middle(points)]));

const towns = execFileSync('unzip', ['-p', join(cache, 'cities1000.zip'), 'cities1000.txt'], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  .split('\n').map((line) => line.split('\t'))
  .filter((fields) => fields[8] === 'IN' && fields[6] === 'P' && Number(fields[14]) >= MIN_POPULATION)
  .map(([, name, , , lat, lon, , , , , , , , , population]) => ({ name, point: [Number(lat), Number(lon)], population: Number(population) }));

const townIndex = new Map();
const pins = [];
for (const [pin, points] of [...offices].sort(([a], [b]) => a.localeCompare(b))) {
  const kept = points.filter((point) => distanceKm(point, districtMiddle.get(pin.slice(0, 3))) <= OUTLIER_KM);
  if (!kept.length) continue;
  const at = middle(kept);
  let best = null;
  for (const town of towns) {
    const km = distanceKm(at, town.point);
    if (km > MAX_KM) continue;
    const score = Math.log10(town.population) - km / KM_PER_DECADE;
    if (!best || score > best.score) best = { town, score };
  }
  if (!best) continue;
  const key = `${best.town.name}:${best.town.point.join(',')}`;
  if (!townIndex.has(key)) townIndex.set(key, [townIndex.size, best.town]);
  pins.push([Number(pin), townIndex.get(key)[0]]);
}

// Runs of PINs in one town, with no PIN of another town between them: [first, last, town].
const ranges = [];
for (const [pin, town] of pins) {
  const last = ranges.at(-1);
  if (last && last[2] === town) last[1] = pin;
  else ranges.push([pin, pin, town]);
}
const round = (value) => Math.round(value * 1e3) / 1e3;
const output = {
  source: 'All India Pincode Directory, Department of Posts, data.gov.in, GODL-India; towns: GeoNames, CC BY 4.0. Generated by scripts/generate-pincodes.mjs.',
  towns: [...townIndex.values()].map(([, town]) => [town.name, round(town.point[0]), round(town.point[1])]),
  ranges,
};
const text = `{\n  "source": ${JSON.stringify(output.source)},\n  "towns": [\n${output.towns.map((town) => `    ${JSON.stringify(town)}`).join(',\n')}\n  ],\n  "ranges": [\n${
  output.ranges.map((range) => `    ${JSON.stringify(range)}`).join(',\n')}\n  ]\n}\n`;
await writeFile(join(root, 'places/pincodes.json'), text);
console.log(`pincodes.json: ${offices.size} PINs, ${pins.length} placed in ${townIndex.size} towns, ${ranges.length} ranges, ${Math.round(text.length / 1024)} KB`);
