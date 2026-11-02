import { classifyWording } from '../../core/status/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';

// "Arrive <Town>, at the sorting and distribution center": the town after the verb.
const ARRIVE = /^(Arrive)\s+([^,]{1,80}),\s*(at\s.+)$/i;
// A town: letters and the marks town names use, without digits.
const TOWN = /^\p{Lu}[\p{L}\p{M} .'’()-]{0,79}$/u;
// A postcode between the town and the wording: `00000`, `00-000`, `AB1 2CD`.
const POSTCODE_SEGMENT = /^(?=.*\d)[\p{Lu}\d][\p{Lu}\d -]{1,9}$/u;
// A postcode opening the segment after a region: "00000 Arrive at …" or "00000".
const POSTCODE_LEAD = /^\d{4,6}(?:-\d{4})?(?![\p{L}\p{N}])/u;
// "Town Import customs clearance": the port's town before the clearance.
const CLEARANCE = /^(.{1,80}?)\s+(import customs clearance\b.*)$/i;
// A word holding a digit next to a town, as a postcode written before it.
const DIGIT_WORD = /(?:^|\s+)\S*\d\S*/gu;
// Four to six digits standing alone are a postcode far more often than anything else.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// A run of nine or more digits, with the separators phone numbers are written with; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took a delivered parcel, as a courier's delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;

/** A town, without a postcode written beside it, or '' when the text is not one. */
function town(value: string): string {
  const name = clean(value.replace(DIGIT_WORD, ' '), 80);
  // Wording the shared rules read is a scan, not a place: "Delivery failed, …".
  return TOWN.test(name) && classifyWording(name, 'pending').source === 'none' ? name : '';
}

/** Scan text without postcodes, phone numbers or who took a delivered parcel. */
function scrub(value: string): string {
  const unsigned = /^delivered\b/i.test(value) ? value.replace(RECEIVER, '') : value;
  return clean(unsigned.replace(PHONE, ' ').replace(POSTCODE_RUN, '$1'), 300).replace(/^[\s,;:]+|[\s,;:]+$/g, '');
}

/**
 * A row's wording and place. Rows at the destination open with the town and,
 * on a delivery, the postcode: "Town, 00000, Delivered". In the United States
 * the state comes between them: "Town, State, 00000 Arrive at …". One names
 * the town after its verb: "Arrive Town, at the sorting and distribution
 * center", and the import clearance before it: "Town Import customs
 * clearance". The town, and the state with it, becomes the location and the
 * postcode is dropped; text that does not open with a town stays whole.
 */
export function linhanScan(content: string): { description: string; location: string } {
  const text = textFromHtml(content, 300);
  const arrive = ARRIVE.exec(text);
  const arrivedAt = arrive ? town(arrive[2]!) : '';
  if (arrive && arrivedAt) return { description: scrub(`${arrive[1]} ${arrive[3]}`), location: arrivedAt };
  const clearance = CLEARANCE.exec(text);
  // The destination agent's clearance names no town.
  const port = clearance && !/\b(?:agent|carrier)\b/i.test(clearance[1]!) ? town(clearance[1]!) : '';
  if (clearance && port) return { description: scrub(clearance[2]!), location: port };
  const [head = '', ...rest] = text.split(/\s*,\s*/);
  const region = rest.length > 1 && POSTCODE_LEAD.test(rest[1]!) ? town(rest[0]!) : '';
  if (region) rest.shift();
  while (rest.length && POSTCODE_SEGMENT.test(rest[0]!)) rest.shift();
  const place = rest.length ? town(head) : '';
  const description = place ? scrub(rest.join(', ')) : '';
  if (place && /\p{L}/u.test(description)) return { description, location: region ? `${place}, ${region}` : place };
  return { description: scrub(text), location: '' };
}
