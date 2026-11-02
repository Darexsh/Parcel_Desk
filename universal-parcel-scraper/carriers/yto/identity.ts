import { translatedScanPolicy } from '../../core/status/english.js';
import { ytoScan } from './status.js';

// Rows stored in YTO's Chinese label before the adapter showed its English
// are taken over by the English row at the same instant and place.
export const sameInstantIdentityPolicy = translatedScanPolicy('yto', (wording) => ytoScan(wording)?.wording);
