import { translatedScanPolicy } from '../../core/status/english.js';
import { mayiyinfuEnglish } from './status.js';

// A flight row stored with the day it expects is taken over by its step's
// English at the same instant and place.
export const sameInstantIdentityPolicy = translatedScanPolicy('mayiyinfu', (wording) => mayiyinfuEnglish(null, wording));
