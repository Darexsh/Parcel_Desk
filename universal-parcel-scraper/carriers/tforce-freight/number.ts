import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';

// A PARS number for the Canadian border: TForce Freight's carrier code 2205 and the PRO.
export const TFORCE_PARS = /^2205(\d{9})$/;

/** The PRO a PARS number carries, when its check digit holds; null for anything else. */
export function tforceParsPro(number: string): string | null {
  const pro = TFORCE_PARS.exec(number)?.[1];
  return pro && hasMod7CheckDigit(pro) ? pro : null;
}
