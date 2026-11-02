/**
 * Tracking-number detection.
 *
 * What it is: the one engine that normalizes a number, validates its checksum,
 * decides which carrier it belongs to, and parses whatever a user pastes. The
 * web client, the server and the corpus sweep all import it from here.
 * What it is not: no provider I/O, no HTTP, no Node APIs, no application or
 * framework code — it bundles for the browser unchanged.
 */
export type {
  CarrierDetection,
  ChecksumRejection,
  DetectionConfidence,
  TrackingInputMatch,
} from './types.js';
export { AMAZON_NUMBER_PATTERN, isAmazonTrackingNumber } from './amazon.js';
export {
  TRACKING_CANDIDATE_PATTERNS,
  keywordNumberInText,
  recognizedNumberInText,
} from './candidates.js';
export { isValidCorreosSpainCheckLetter } from './correosSpain.js';
export { isValidDpdParcelNumber } from './dpd.js';
export { checksumRejections, detectCarrier, detectCarrierMatch } from './detect.js';
export { isValidGlsParcelNumber } from './gls.js';
export { isValidHermesParcelNumber } from './hermes.js';
export { isValidMondialRelayBarcode } from './mondialRelay.js';
export { isValidDhlExpressWaybill, isValidPocztaPolskaBarcode, isValidSscc, isValidTntConsignmentNumber } from './numericChecksums.js';
export { formatTrackingNumber, isPlanzerSharedTrackingNumber, normalizeTrackingNumber } from './normalize.js';
export { parseTrackingInput } from './parse.js';
export { isPhoneNumber } from './phone.js';
export { isPlaceholderNumber } from './placeholder.js';
export { isValidS10TrackingNumber, supportsSwissPostHandoff } from './s10.js';
export { isValidUspsPackageBarcode, uspsPackageIdentifier } from './usps.js';
export { validTrackingNumber } from './valid.js';
