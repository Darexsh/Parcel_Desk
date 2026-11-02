import { translatedScanPolicy } from '../../core/status/english.js';
import { allegroOneEnglish } from './status.js';

// The service words a scan in English or Polish, as the lookup asks. At one
// instant, a scan in one language takes over the row stored in the other when
// its wording translates the stored one.
export const sameInstantIdentityPolicy = translatedScanPolicy('allegro-one', allegroOneEnglish);
