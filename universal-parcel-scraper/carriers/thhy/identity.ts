import { translatedScanPolicy } from '../../core/status/english.js';
import { thhyEnglish } from './status.js';

// Rows stored in the carrier's Chinese before the adapter showed their English
// are taken over by the English row at the same instant and place.
export const sameInstantIdentityPolicy = translatedScanPolicy('thhy', (wording) => thhyEnglish(null, wording));
