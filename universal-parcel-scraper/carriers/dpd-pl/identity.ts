import { translatedScanPolicy } from '../../core/status/english.js';
import { dpdPlEnglish } from './status.js';

// The page words a scan in English or Polish, as its session asks. At one
// instant, a scan in one language takes over the row stored in the other when
// its wording translates the stored one.
export const sameInstantIdentityPolicy = translatedScanPolicy('dpd-pl', dpdPlEnglish);
