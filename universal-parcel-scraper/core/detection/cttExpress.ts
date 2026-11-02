/**
 * Spanish shipment references and the sole package's complete label code: the
 * customer's agency, the origin agency and a ten-digit counter. Every code in
 * CTT Express's agency list starts with 00, which keeps other carriers'
 * 22-digit barcodes out.
 */
export function isCttExpressTrackingNumber(number: string): boolean {
  return /^00\d{4}00\d{14}(?:001)?$/.test(number);
}
