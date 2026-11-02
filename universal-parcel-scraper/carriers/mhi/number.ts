// MHI, its client's three digits, then a W and twelve digits, WBB and nine
// digits, P and nine digits, or twelve digits.
export const MHI_LAYOUT = /^MHI(\d{3})(W\d{12}|WBB\d{9}|P\d{9}|\d{12})$/;

/**
 * A number as MHI's tracker matches it. Labels print a P series number with
 * dashes after MHI and the client's digits (MHI-123-P123456789), which
 * normalization drops, and the tracker finds it only with them; the other
 * series have none. Shared by the adapter's requests and the tracking links.
 */
export function mhiPrintedNumber(number: string): string {
  const parts = MHI_LAYOUT.exec(number);
  return parts?.[2]!.startsWith('P') ? `MHI-${parts[1]}-${parts[2]}` : number;
}
