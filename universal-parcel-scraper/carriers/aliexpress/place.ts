import { usStateTimeZone } from '../../core/time/index.js';
import { ambiguousAddressCodes, countryName, trackingPlace } from '../../places/trackingLocation.js';

/**
 * A name that reads as a place, or ''. Codes, ambiguous capitals-only names
 * and the module's carrier names are none.
 */
export function placeName(value: string, carriers: ReadonlySet<string>): string {
  const place = value.trim();
  // An explicit numbered city district is a place even in uppercase. Keep
  // arbitrary numbers and facility codes excluded from the general rule.
  const arrondissement = /^(?:Paris (?:[1-9]|1\d|20)|Lyon [1-9]|Marseille (?:[1-9]|1[0-6]))(?:er|e|eme|ème) arrondissement$/i.test(place);
  const letters = place.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 3 || (!arrondissement && (!/^\p{L}[\p{L}\p{M} .'’-]*$/u.test(place)
    || (/\p{Lu}/u.test(place) && !/\p{Ll}/u.test(place)))) || carriers.has(place.toLocaleLowerCase('en-US'))) {
    return '';
  }
  return place;
}

/** The country a name or code alone names, with a code a state shares ("CA") written out, or ''. */
function countryLabel(value: string): string {
  const { country, place } = trackingPlace(value);
  if (!country || place) return '';
  return ambiguousAddressCodes.has(value.trim()) ? countryName(country, 'en') : value.trim();
}

/**
 * A town's name, or ''. Beside its country or its state, a town in capitals
 * counts too, with five letters or more or several words.
 */
function townName(name: string, carriers: ReadonlySet<string>, qualified: boolean): string {
  const letters = name.match(/\p{L}/gu)?.length ?? 0;
  const capitals = qualified && /^\p{Lu}[\p{Lu}\p{M} .'’-]*$/u.test(name)
    && (letters >= 5 || (letters >= 3 && /\s/u.test(name))) && !carriers.has(name.toLocaleLowerCase('en-US'));
  return capitals ? name : placeName(name, carriers);
}

// A town in the United States with its state and ZIP code, as USPS writes one: "Example City, CA 00000".
const US_TOWN = /^([^,]+),\s*([A-Z]{2})\s+(\d{5})$/u;

/**
 * The place of a bracket, or ''. A town can follow its country, "[USA,Example City]",
 * and keeps a trailing postcode, "[Example Town 00000]". A town in the United States
 * can come with its state and ZIP code, "[Example City, CA 00000]". A country alone
 * is the place too, "[ES]" or "[Spain 00000]", with the postcode put first so the
 * country stays last.
 */
function bracketPlace(value: string, carriers: ReadonlySet<string>): string {
  const us = US_TOWN.exec(value.trim());
  if (us && usStateTimeZone(us[2])) {
    const town = townName(us[1]!.trim(), carriers, true);
    return town ? `${town}, ${us[2]} ${us[3]}` : '';
  }
  const [, head = '', rest] = /^([^,]+)(?:,([^,]+))?$/u.exec(value) ?? [];
  const country = rest === undefined ? '' : countryLabel(head);
  if (rest !== undefined && !country) return '';
  const [, name = '', postcode] = /^(.*?)(?:\s+(\d{4,5}))?$/u.exec((rest ?? head).trim())!;
  const alone = country ? '' : countryLabel(name);
  if (alone) return postcode ? `${postcode}, ${alone}` : alone;
  const town = townName(name, carriers, Boolean(country));
  const place = town && postcode ? `${town} ${postcode}` : town;
  return place && country ? `${place}, ${country}` : place;
}

/**
 * Cainiao's global feed has no place field: it writes a scan's town in front
 * of its standard wording, "[Bordeaux] Out for delivery", in every language,
 * sometimes after its country, "[USA,Example City]", or its country alone, "[ES]".
 * A bracket that reads as a place becomes the location and the wording keeps the rest.
 */
export function placedWording(wording: string, carriers: ReadonlySet<string>): { description: string; location: string } {
  const match = /^\s*\[([^[\]]{1,80})\]\s*(\S[\s\S]*)$/.exec(wording);
  const place = match ? bracketPlace(match[1]!, carriers) : '';
  return place ? { description: match![2]!.trim(), location: place } : { description: wording, location: '' };
}
