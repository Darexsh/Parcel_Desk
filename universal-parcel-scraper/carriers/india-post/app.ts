import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// MySpeedPost changes a scan's wording while its instant and event_type stay the same.
// Scans abroad were read on India's clock until October 2026 and now show the
// destination's offset, unless a reply lacks what places them abroad.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: true, relabelledFrom: 'Asia/Kolkata',
};
