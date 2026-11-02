// Place-name keys shared by the gazetteer generator and the server lookup, so
// both sides spell every name the same way. Plain JavaScript on purpose: the
// generator runs in Node without a TypeScript build.

const letters = { ß: 'ss', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o', œ: 'oe', Œ: 'oe', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ı: 'i', þ: 'th', ð: 'd' };
const german = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue' };
// Halves that only point within a town ("Neustadt/Süd"), not a name of their own.
const directions = new Set(['nord', 'sud', 'ost', 'west', 'north', 'south', 'east', 'mitte', 'zentrum', 'centre', 'center']);

/**
 * Lower case, no accents, words separated by single spaces:
 * "Zürich" and "ZURICH" both become "zurich", "St. Gallen" becomes "st gallen".
 * Chinese, Japanese, Korean and Cyrillic script stays as written: "深圳", "тюмень".
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return name
    .replace(/[ßæÆøØœŒłŁđĐıþð]/g, (letter) => letters[/** @type {keyof typeof letters} */ (letter)])
    .normalize('NFD')
    // Kana voicing marks are part of the letter, not an accent.
    .replace(/(?![\u3099\u309a])\p{Mn}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]+/gu, ' ')
    .trim();
}

/**
 * Every key a name answers to, including the German transliteration carriers
 * print in capitals ("ZUERICH", "KOELN") and each half of a bilingual name
 * ("Biel/Bienne"). A half of three Latin letters or fewer, or a direction, is
 * no name.
 * @param {string} name
 * @returns {string[]}
 */
export function nameKeys(name) {
  const keys = new Set([nameKey(name), nameKey(name.replace(/[äöüÄÖÜ]/g, (letter) => german[/** @type {keyof typeof german} */ (letter)]))]);
  if (name.includes('/')) {
    for (const part of name.split('/').map(nameKey)) {
      if ((part.length > 3 || /[^a-z0-9 ]/.test(part)) && !directions.has(part)) keys.add(part);
    }
  }
  keys.delete('');
  return [...keys];
}
