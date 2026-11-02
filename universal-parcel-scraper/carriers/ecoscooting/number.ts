import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { isSheinPackageNumber } from '../../core/detection/shein.js';

// Cainiao's Spanish and Portuguese reference after its "CN": the destination,
// its postcode (five digits in Spain, seven in Portugal), 1234 and a counter.
const WITHOUT_CN = /^(?:ESP\d{5}1234\d{11}|PRT\d{7}1234\d{9})$/;
const REFERENCE = /^(?:\d{18}|CN(?:ESP|PRT)\d{20})$/;

/**
 * The number with the `CN` of a Cainiao reference typed without it put back,
 * since neither Ecoscooting nor Cainiao answers the reference without. Any
 * other number is returned normalized. Shared by the adapter's requests and
 * the tracking links.
 */
export function ecoscootingReference(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  return WITHOUT_CN.test(number) ? `CN${number}` : number;
}

/** An 18-digit label or a `CNESP`/`CNPRT` reference, the numbers Ecoscooting issues. */
export function isEcoscootingLabel(number: string): boolean {
  return REFERENCE.test(number);
}

/**
 * A number as Ecoscooting's gateway matches it: an 18-digit label, a
 * `CNESP`/`CNPRT` reference, or the SHEIN package number its label was made for.
 */
export function ecoscootingRequestNumber(raw: string): string {
  const number = ecoscootingReference(raw);
  if (!isEcoscootingLabel(number) && !isSheinPackageNumber(number)) {
    throw new InvalidInputError('Ecoscooting', 'Ecoscooting requires a numeric, CNESP or CNPRT parcel reference, or a SHEIN package number');
  }
  return number;
}
