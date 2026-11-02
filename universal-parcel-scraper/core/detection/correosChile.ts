import { isValidS10TrackingNumber } from './s10.js';

/**
 * The numbers Correos de Chile's tracker is asked about: thirteen digits, or a Chilean postal
 * item, an S10 number ending `CL` with a valid check digit. Other posts' numbers are refused.
 */
export function isCorreosChileLookup(number: string): boolean {
  return /^\d{13}$/.test(number) || (/^[A-Z]{2}\d{9}CL$/.test(number) && isValidS10TrackingNumber(number));
}
