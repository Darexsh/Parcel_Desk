import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Out-for-delivery scans read "Arrived at delivery center", final-hub arrivals
// "In transit", and the van's departure was staged in transit, until October
// 2026. The scan's instant and event code stay the same. Until then too, the
// tracker's UTC clocks were read on the number's country's clock, or a US
// number's scan place's: a scan shows its stored row's wall clock under +00:00.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'amazon-shipping', storedSources: ['amazon-shipping'], requireProviderCode: true, matchWallClock: true,
};
