/** Check normalized numeric identifiers; a valid checksum does not identify a shipment. */

/** MyDHL+ uses the remainder of the first nine digits divided by seven. */
export function isValidDhlExpressWaybill(value: string): boolean {
  return value.length === 10 && /^\d{10}$/.test(value) && Number(value.slice(0, 9)) % 7 === Number(value[9]);
}

/**
 * The number before the last digit, divided by seven, leaves the last digit:
 * the Japanese "7DR" check on Yamato's 12-digit numbers and Japan Post's
 * 11-digit registered mail, and the check Blue Dart and Aramex 11-digit
 * waybills and XPO's nine-digit PROs carry. It does not tell those carriers
 * apart.
 */
export function hasMod7CheckDigit(value: string): boolean {
  return /^\d{2,15}$/.test(value) && Number(value.slice(0, -1)) % 7 === Number(value.at(-1));
}

/**
 * Saia's tracker calls the twelfth digit of a PRO a check digit. On every public twelve-digit
 * PRO the eleventh digit is 0 and the twelfth is the remainder of the first ten divided by seven,
 * which is inferred, not published; a PRO with another eleventh digit is not checked.
 */
export function isValidSaiaPro(value: string): boolean {
  return /^\d{10}0[0-6]$/.test(value) && Number(value.slice(0, 10)) % 7 === Number(value[11]);
}

/** TNT ExpressConnect supports Mod 7 and Mod 11 for international consignments. */
export function isValidTntConsignmentNumber(value: string): boolean {
  if (value.length !== 9 || !/^\d{9}$/.test(value)) return false;
  const check = Number(value[8]);
  return Number(value.slice(0, 8)) % 7 === check || tntConsignmentCheckDigit(value.slice(0, 8)) === check;
}

/** The Mod 11 check digit of a consignment's eight-digit serial, the one tnt.com adds to a serial typed alone. */
export function tntConsignmentCheckDigit(serial: string): number {
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce((total, weight, index) => total + Number(serial[index]) * weight, 0);
  const digit = 11 - sum % 11;
  return digit === 11 ? 5 : digit === 10 ? 0 : digit;
}

/** Mod 11 with weights 2 to 7 repeating from the right; a result of 10 or 11 becomes 0. */
export function mod11CheckDigit(digits: string): number {
  const sum = [...digits].reverse().reduce((total, digit, i) => total + Number(digit) * (2 + i % 6), 0);
  const remainder = 11 - sum % 11;
  return remainder >= 10 ? 0 : remainder;
}

/**
 * Ukrposhta's 13-digit domestic barcode ends in the mod 11 check of its first
 * twelve digits. The numbers in Ukrposhta's API documentation pass it, apart
 * from a placeholder and one example that writes a check of 11 as 1.
 */
export function isValidUkrposhtaBarcode(value: string): boolean {
  return /^\d{13}$/.test(value) && mod11CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

/** GS1 mod 10: counted from the check digit, the digits before it weigh 3, 1, 3, … */
export function hasGs1CheckDigit(value: string): boolean {
  if (!/^\d{2,}$/.test(value)) return false;
  const sum = [...value.slice(0, -1)].reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(value.at(-1));
}

/** Luhn over every digit, the last one being the check: Purolator's 12-digit PINs. */
export function hasLuhnCheckDigit(value: string): boolean {
  if (!/^\d{2,}$/.test(value)) return false;
  const sum = [...value].reverse().reduce((total, digit, index) => {
    const doubled = Number(digit) * (index % 2 ? 2 : 1);
    return total + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return sum % 10 === 0;
}

/**
 * FedEx 12-digit tracking numbers: the first eleven digits weigh 3, 1, 7, …
 * from the left, and the sum mod 11 mod 10 is the last digit. The same number
 * closes FedEx's longer Express and Ground barcodes.
 */
export function isValidFedExTrackingNumber(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const weights = [3, 1, 7];
  const sum = [...value.slice(0, 11)].reduce((total, digit, index) => total + Number(digit) * weights[index % 3]!, 0);
  return sum % 11 % 10 === Number(value[11]);
}

/**
 * Poste Italiane registered mail: eleven digits and a check digit, as its barcode specification
 * defines it. Eleven times the sum of the digits in even places, plus the sum of those in odd
 * places, gives a number whose digit sum mod 10 is the check.
 */
export function isValidPosteItalianeRegisteredNumber(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const [odd, even] = [...value.slice(0, 11)].reduce(([oddSum, evenSum], digit, index) =>
    index % 2 ? [oddSum, evenSum + Number(digit)] : [oddSum + Number(digit), evenSum], [0, 0]);
  return [...String(11 * even + odd)].reduce((total, digit) => total + Number(digit), 0) % 10 === Number(value[11]);
}

/** The eMonitoring widget appends this GS1 digit to its 19-digit numeric alias. */
export function isValidPocztaPolskaBarcode(value: string): boolean {
  return value.length === 20 && /^\d{20}$/.test(value) && hasGs1CheckDigit(value);
}

/**
 * An SSCC behind its GS1 application identifier `00`, as freight labels print
 * it. Shippers issue SSCCs under their own company prefix, so a valid one names
 * no carrier.
 */
export function isValidSscc(value: string): boolean {
  return value.length === 20 && /^00\d{18}$/.test(value) && hasGs1CheckDigit(value);
}
