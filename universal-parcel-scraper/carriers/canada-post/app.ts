import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Scans relayed from other posts kept Canada Post's -05:00 or -04:00 until
// October 2026, and those in a country with one clock now show its offset.
// The old label is read as -05:00, the one Canada Post gives them in winter and
// often in summer; a row stored under -04:00 is not recognized.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'canada-post', storedSources: ['canada-post'], requireProviderCode: true, relabelledFrom: 'Etc/GMT+5',
};
