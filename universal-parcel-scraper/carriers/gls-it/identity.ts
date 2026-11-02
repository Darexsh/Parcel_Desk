import { translatedScanPolicy } from '../../core/status/english.js';
import { glsItalyEnglish } from './status.js';

// The English locale sometimes answers in Italian. At one instant, a scan
// shown in English takes over the row stored with its Italian sentence.
export const sameInstantIdentityPolicy = translatedScanPolicy('gls-it', glsItalyEnglish);
