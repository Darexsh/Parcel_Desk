import { clean } from '../../core/transport/text.js';

// Four to six digits standing alone in scan text are a postcode far more often than anything else,
// except a date's year, as in "2026-10-24", "24/10/2026" or "March 10, 2026".
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])(?<!\d{1,2}[-/.]\d{1,2}[-/.]|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2},? ?)(?!\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d))\d{4,6}(?![\p{L}\p{N}])/giu;
// The postcodes written otherwise in a delivery row's place: three and two digits (Greece, Czechia,
// Slovakia, Sweden), two and three or four and three with a dash (Poland, Portugal), letters and digits
// (Canada, the United Kingdom) and four digits and two letters (the Netherlands).
const POSTCODE_FORM = /(^|[^\p{L}\p{N}])(?:\d{3} \d{2}|\d{2}-\d{3}|\d{4}-\d{3}|[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{4} ?[A-Z]{2})(?![\p{L}\p{N}])/gu;
// A country's letters before a postcode, as in "CH-8001" or "NL-1012 AB", go with it.
const POSTCODE_COUNTRY = /(^|[^\p{L}\p{N}])[A-Z]{1,2}-(?=(?:\d{2}-\d{3}|\d{4} ?[A-Z]{2}|\d{4,6})(?![\p{L}\p{N}]))/gu;
// Brackets a postcode leaves empty.
const EMPTY_BRACKETS = /\(\s*\)|（\s*）/g;
// A signatory's name follows these markers.
const SIGNATORY = /(?:签收人|signed (?:for )?by|signatory)[\s\S]*$/i;

// The interface replies in GBK, which has no room for some spaces: one between two words arrives as `?`.
const LOST_SPACE = /(?<=\p{L})\?(?=\p{L})/gu;

// A partner's row can come with its markup, escaped or not: DHL's "more information<a href=…> here.</a>".
const MARKUP = /<\/?[a-z][^<>]*>|&lt;\/?[a-z][\s\S]*?&gt;/gi;
const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const ENTITY = /&(?:amp|quot|#39|apos|nbsp);/g;

/** Scan text without markup, a signatory or a postcode. */
export function hualeiScanText(value: string, maxLength = 500): string {
  return clean(value.replace(MARKUP, ' ').replace(ENTITY, (entity) => ENTITIES[entity]!).replace(LOST_SPACE, ' ').replace(SIGNATORY, '').replace(POSTCODE_COUNTRY, '$1').replace(POSTCODE_FORM, '$1')
    .replace(POSTCODE_RUN, '$1').replace(EMPTY_BRACKETS, ''), maxLength)
    .replace(/^[\s,，:：;；/]+|[\s,，:：;；/]+$/g, '');
}
