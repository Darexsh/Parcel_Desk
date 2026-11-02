import { hasGs1CheckDigit, isValidFedExTrackingNumber } from './numericChecksums.js';

// FedEx label barcodes and the tracking number each carries. A passing check
// digit reads the embedded tracking number; it does not establish ownership.

/**
 * The 22-digit FedEx Ground `96` barcode: `96`, a two-digit SCNC, a
 * three-digit service code, then the 15-digit tracking number (shipper ID,
 * package number and check digit). Its GS1 mod 10 check covers only that
 * tracking number. Bar Code & Label Layout Specification, pp. 37–38:
 * https://web.archive.org/web/20160803154112/http://www.fedex.com/us/solutions/ppe/FedEx_Ground_Label_Layout_Specification.pdf
 */
export function isValidFedExGround96Barcode(value: string): boolean {
  return /^96\d{20}$/.test(value) && hasGs1CheckDigit(value.slice(7));
}

/**
 * The 34-digit FedEx 1D barcode, on Express and Ground labels: positions 21–34
 * hold the tracking number, a 12-digit FedEx number behind two zeros. Its own
 * check runs weights 1, 3, 7 from the right over the 13 digits before the
 * last, sum mod 11 then mod 10; behind those zeros it is the 12-digit check.
 * https://developer.fedex.com/api/en-us/catalog/ship/docs.html
 * https://web.archive.org/web/20180924160356/http://www.fedex.com/us/gsn/
 */
export function isValidFedEx1DBarcode(value: string): boolean {
  return /^\d{20}00\d{12}$/.test(value) && isValidFedExTrackingNumber(value.slice(22));
}

/**
 * The 20-digit FedEx Ground Economy number, formerly SmartPost: a USPS package
 * identifier without its `92` channel, so a three-digit service type code, a
 * Mailer ID and the serial. Its check digit is the identifier's MOD10, computed
 * with the `92` in front: https://postalpro.usps.com/pub199
 */
export function isValidFedExGroundEconomyNumber(value: string): boolean {
  return /^\d{20}$/.test(value) && hasGs1CheckDigit(`92${value}`);
}

/** The USPS package identifier a Ground Economy number stands for, or null. */
export function fedexGroundEconomyUspsNumber(value: string): string | null {
  return isValidFedExGroundEconomyNumber(value) ? `92${value}` : null;
}

/** The tracking number a whole FedEx label barcode carries, or null. */
export function fedexBarcodeTrackingNumber(value: string): string | null {
  if (isValidFedExGround96Barcode(value)) return value.slice(7);
  if (isValidFedEx1DBarcode(value)) return value.slice(22);
  return null;
}
