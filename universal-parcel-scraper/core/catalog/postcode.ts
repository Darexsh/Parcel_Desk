/** Any country's postcode: 3 to 12 characters with a digit, in groups joined by one space or hyphen. */
export const DELIVERY_POSTCODE = /^(?=.{3,12}$)(?=.*\d)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/;

/** A typed postcode as it is checked and sent: trimmed, in capitals, with single spaces. */
export function deliveryPostcodeText(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * A Colis Privé recipient postcode as its page takes it after the shipment
 * number: France's five digits, or Belgium's or Luxembourg's four, bare or
 * after B or L. A written country prefix (B-1000, LU 1234) becomes that
 * letter. Null for anything else.
 */
export function colisPrivePostcode(value: string): string | null {
  const text = value.toUpperCase().replace(/\s+/g, '');
  if (/^(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/.test(text)) return text;
  const match = /^(?:(BE?|LU?)-?)?([1-9]\d{3})$/.exec(text);
  if (!match) return null;
  return `${match[1]?.charAt(0) ?? ''}${match[2]}`;
}
