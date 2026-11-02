/**
 * Candidate numbers inside free text.
 *
 * What it is: the shapes worth testing when a whole shipping message, or a URL
 * with no matching link rule, is pasted, and the two scans over them.
 * What it is not: no carrier decision of its own (it defers to the detection
 * engine) and no provider I/O.
 */
import { AMAZON_NUMBER_PATTERN } from './amazon.js';
import { detectCarrierMatch } from './detect.js';
import { validTrackingNumberInText } from './valid.js';

const AMAZON_TEXT_PATTERN = AMAZON_NUMBER_PATTERN.slice(1, -1).replaceAll('[0-9]', '(?:[\\s.-]*[0-9])');

export const TRACKING_CANDIDATE_PATTERNS = [
  // Amazon's digits can be printed in groups. A country's two letters set apart from them are
  // capitals and no abbreviation: "es" in "Su número de seguimiento es 1234567890" and "No." in
  // "Tracking No. 1234567890" are words, not Amazon's.
  new RegExp(`\\b(?![A-Z]{2}[\\s.-])${AMAZON_TEXT_PATTERN}\\b`, 'gi'),
  new RegExp(`\\b(?![A-Z]{2}\\.)${AMAZON_TEXT_PATTERN}\\b`, 'g'),
  // NACEX agency/shipment composites keep their slash boundary (never stripped).
  /\b\d{4}\/\d{8}\b/g,
  // NO LIMIT's shipment numbers are printed with slashes, which normalization drops.
  /\bP\/\d{1,6}\/L[A-Z]{3}\/20\d{2}\b/gi,
  /\b\d{26}\b/g,
  /\bH\d{15,19}\b/gi,
  /\b1Z[A-Z0-9]{16}\b/gi,
  /\b1G[A-Z0-9]{10}\b/gi,
  /\b[A-Z]{2}\s*\d(?:[\s.-]?\d){8}\s*[A-Z]{2}\b/gi,
  /\b(?:JJD|JVGL)[A-Z0-9]{8,}\b/gi,
  /\b\d(?:[\s.-]?\d){9,19}\b/g,
  // Let catalog rules claim other complete identifiers without copying their shapes here.
  /\b[A-Z0-9]{4,40}\b/gi,
];

/** The first candidate in the text that one carrier claims confidently. */
export function recognizedNumberInText(raw: string): string | undefined {
  for (const pattern of TRACKING_CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const candidate = match[0].trim();
      if (detectCarrierMatch(candidate).confidence === 'high') return candidate;
    }
  }
  return undefined;
}

// The second word of a label. "No" and "ID" also start numbers, so they belong
// to the label only when they stand apart from what follows.
const LABEL_SUFFIX = String.raw`(?:numbers?(?!\p{L})|no\.|(?:no|id)(?![\p{L}0-9.]))`;
// Other languages name the parcel or its tracking, with a word for its number
// before or after: "numéro de suivi", "Sendung Nr.", "número de envío", "numer
// przesyłki", or join the two: "Sendungsnummer", "zendingnummer". A courier's
// label names its waybill: "Waybill No.", "AWB", "número de guía".
const PARCEL_WORDS = String.raw`suivi|colis|envoi|sendung|paket|pakket|zending|seguimiento|rastreo|env[ií]o|paquete|gu[ií]a`
  + String.raw`|tracciamento|spedizione|pacco|rastreio|rastreamento|encomenda|przesy[lł]k[ai]|paczk[ai]`;
const NUMBER_WORDS = String.raw`num[eé]ro|n[uú]mero|numer|nummer|nr\.?|n\.?\s?[°º]`;
const LABELLED_NUMBER = new RegExp(
  String.raw`(?:track(?:ing)?(?:\s*${LABEL_SUFFIX}|(?!\p{L}))`
  + String.raw`|(?:parcel|shipment|waybill|awb)(?:\s+(?:tracking(?!\p{L})|${LABEL_SUFFIX})|(?!\p{L}))`
  + String.raw`|(?:(?:${NUMBER_WORDS})\s*(?:(?:de|du|di|del|do|da)\s+|d')?)?(?:${PARCEL_WORDS})(?!\p{L})(?:\s*(?:${NUMBER_WORDS}))?`
  + String.raw`|\p{L}*(?:sendungs|paket|tracking|zending)nummer)`
  + String.raw`(?:\s+(?:is|est|es|ist|lautet|è|é|jest)(?:\s+(?:le|el|il|o))?(?![\p{L}0-9]))?\s*[:#-]?\s*`
  // The token holds a digit, so a label followed by a plain word does not end the search. Groups
  // printed apart may follow it: "1Z 999 AA1 01 2345 6784".
  + String.raw`((?=[A-Z0-9.-]{0,39}\d)(?:[A-Z0-9][A-Z0-9.-]{3,39}|[A-Z0-9][A-Z0-9.-]{1,2}(?=\s[A-Z0-9]*\d))`
  + String.raw`(?:\s[A-Z0-9]{2,6}(?![\p{L}0-9]))*)`,
  'iu',
);
// A word that offers a second number: "tracking 1234567899 or 9987654321".
export const ALTERNATIVE_WORDS = 'or|oder|ou|o|of|lub';
const ALTERNATIVE_NUMBER = new RegExp(String.raw`^\s+(?:${ALTERNATIVE_WORDS})\s+[A-Z0-9.-]*\d`, 'i');
const DATE = /^\d{1,2}([./-])\d{1,2}\1\d{2,4}$/;

/**
 * Last resort: a number introduced by a "tracking number:" style label. A
 * label that offers two numbers names neither, and a date is no number. A
 * number printed in groups is read whole when a carrier claims it or when
 * its groups are short and make eight characters or more: "0034 0434 1234 5678".
 */
export function keywordNumberInText(raw: string): string | undefined {
  const match = LABELLED_NUMBER.exec(raw);
  if (!match) return undefined;
  // Each later group holds a digit, but for the two capitals that close an S10 code: "RR 123 456 789 FR".
  const [first, ...rest] = match[1]!.split(/\s/);
  const groups = [first!];
  for (const group of rest) {
    const digits = /\d/.test(group);
    if (!digits && !/^[A-Z]{2}$/.test(group)) break;
    groups.push(group);
    if (!digits) break;
  }
  const end = match.index + match[0].length - match[1]!.length + groups.join(' ').length;
  if (ALTERNATIVE_NUMBER.test(raw.slice(end))) return undefined;
  // A sentence can end right after its number.
  const joins = groups.map((_, count) => groups.slice(0, count + 1).join('').replace(/[.-]+$/, ''));
  const claimed = joins.slice(1).reverse().find((joined) => detectCarrierMatch(joined).confidence === 'high');
  const grouped = groups.length > 1 && groups.every((group) => group.length <= 6) && joins.at(-1)!.length >= 8
    && !DATE.test(groups.join('.')) ? joins.at(-1) : undefined;
  const candidate = claimed ?? grouped ?? joins[0]!;
  if (candidate.length < 4 || DATE.test(candidate)) return undefined;
  return validTrackingNumberInText(candidate) ? candidate : undefined;
}
