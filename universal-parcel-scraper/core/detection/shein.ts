/**
 * SHEIN's package number: `C` or `E`, the order date as two-digit year, month
 * and day, and eight digits. SHEIN prints it on parcels its last-mile partners
 * deliver, so the shape names no carrier: in Spain both Paack and Ecoscooting
 * take it.
 */
export const SHEIN_PACKAGE_NUMBER = /^[CE]2\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{8}$/;

export function isSheinPackageNumber(number: string): boolean {
  return SHEIN_PACKAGE_NUMBER.test(number);
}
