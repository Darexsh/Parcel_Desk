/**
 * Helpers shaped for the parcel app this package was extracted from: its
 * parcel view, carrier-name hints for provider results, the clock helpers
 * its sync uses, carrier scan-identity policies, what a carrier's status map
 * says about a scan the app reviews, Swiss Post's status codes that a
 * status-only answer carries as its text, and the country a scan's location
 * names. They change with that app and carry no stability promise; the
 * tracking contract is the other entry points.
 */
export * from './core/catalog/parcel.js';
export * from './core/catalog/hints.js';
export * from './core/time/result.js';
export { sameInstantIdentityPolicy, type SameInstantIdentityPolicy, type SameInstantScan } from './core/catalog/eventIdentity.js';
export { universalCarrierHints } from './providers/shared/hints.js';
export { recognitionAskedCarriers } from './core/catalog/recognition.js';
export { statusMapAnswer, type ObservedStatus, type StatusMapAnswer } from './core/catalog/statusMaps.js';
export { normalizeStatusWording } from './core/status/statusMap.js';
export { SWISS_POST_GLOBAL_STATUSES } from './carriers/swiss-post/status.js';
export { countryFlag, countryName, trackingLocationCountry, trackingPlace, type TrackingPlace } from './places/trackingLocation.js';
