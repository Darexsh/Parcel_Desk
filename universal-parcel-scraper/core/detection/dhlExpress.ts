/**
 * DHL Express piece identifiers.
 *
 * What it is: the label's lower barcode, "(J)JD" and DHL's ISO piece identifier,
 * in the JD01 range Express labels carry, shared by the hand-off and the adapter.
 * What it is not: no carrier lookup; a piece in the range need not exist.
 */

/**
 * The piece as DHL lists it, without the (J) data identifier a typed number can
 * carry before or after it, or null. The caller passes a normalized number.
 */
export function dhlExpressPieceId(value: string): string | null {
  const match = /^J?(JD01\d{16})$|^(JD01\d{16})J$/.exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}
