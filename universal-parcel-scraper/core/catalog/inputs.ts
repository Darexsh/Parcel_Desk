/** Validate parcel credentials against the catalog and pure carrier URL validators. */
import { activeRequirements, carrierDefinition, type CarrierRequirementRule } from './index.js';
import { isValidMondialRelayBarcode } from '../detection/index.js';
import { validateDachserTrackingUrl } from './urls.js';
import { validatePlanzerSharedUrl } from './urls.js';
import { validateInstaboxTrackingUrl } from './urls.js';
import { validateFreightwaysTrackingUrl } from './urls.js';
import { DELIVERY_POSTCODE, colisPrivePostcode, deliveryPostcodeText } from './postcode.js';

export {
  AUTOMATIC_CARRIER_IDS,
  CARRIER_NAMES,
  activeRequirements,
  carrierAdapter,
  carrierDefinition,
  carrierTimezone,
  requiredRequirements,
} from './index.js';
export {
  isValidS10TrackingNumber,
  supportsSwissPostHandoff,
} from '../detection/index.js';

/**
 * Older clients may still supply a postcode for Mondial Relay numbers that
 * need none: label barcodes and the 10- and 12-digit forms. It is validated
 * when present, while they work without one.
 */
function mondialWithoutPostcode(carrierId: string, trackingNumber: string): boolean {
  return carrierId === 'mondial-relay' && /^(?:\d{10}|\d{12}|\d{26})$/.test(trackingNumber);
}

/** Whether the carrier reads a delivery postcode for this number, required or optional. */
export function carrierTakesPostcode(carrierId: string, trackingNumber: string): boolean {
  return mondialWithoutPostcode(carrierId, trackingNumber)
    || activeRequirements(carrierId, trackingNumber).some((item) => item.field === 'postcode');
}

export function normalizeCarrierInputs(
  carrierId: string,
  trackingNumber: string,
  trackingUrl: string,
  postcode: string,
): { trackingUrl: string | null; postcode: string | null } {
  const supplied: Record<'trackingUrl' | 'postcode', string | null> = {
    trackingUrl: trackingUrl.trim() || null,
    postcode: postcode.trim() || null,
  };
  const mondialBarcode = carrierId === 'mondial-relay' && /^\d{26}$/.test(trackingNumber);
  if (mondialBarcode && !isValidMondialRelayBarcode(trackingNumber)) {
    throw new TypeError('Invalid Mondial Relay barcode');
  }
  const requirements = new Map<'trackingUrl' | 'postcode', CarrierRequirementRule>(
    activeRequirements(carrierId, trackingNumber).map((item) => [item.field, item]),
  );
  if (mondialWithoutPostcode(carrierId, trackingNumber) && supplied.postcode) {
    requirements.set('postcode', { field: 'postcode', validator: 'internationalPostcode' });
  }
  for (const [field, value] of Object.entries(supplied) as Array<[
    'trackingUrl' | 'postcode',
    string | null,
  ]>) {
    if (value !== null && !requirements.has(field)) {
      if (field === 'trackingUrl') {
        throw new TypeError('A tracking URL is not used for this carrier or tracking number');
      }
      throw new TypeError('A delivery postcode is not used for this carrier or tracking number');
    }
  }
  for (const [field, requirement] of requirements) {
    const value = supplied[field];
    if (!value) {
      // An optional input only unlocks extra detail; a supplied one is still checked below.
      if (requirement.optional) continue;
      if (field === 'trackingUrl') {
        throw new TypeError(`${carrierDefinition(carrierId).displayName} requires its complete tracking URL`);
      }
      if (requirement.validator === 'swissPostcode') {
        throw new TypeError(
          `${carrierDefinition(carrierId).displayName} requires the four-digit delivery postcode`,
        );
      }
      if (requirement.validator === 'francePostcode' || requirement.validator === 'germanyPostcode') {
        throw new TypeError(
          `${carrierDefinition(carrierId).displayName} requires the five-digit delivery postcode`,
        );
      }
      if (requirement.validator === 'swissOrFrancePostcode') {
        throw new TypeError(
          `${carrierDefinition(carrierId).displayName} requires a four- or five-digit delivery postcode`,
        );
      }
      if (requirement.validator === 'paackPostcode') {
        throw new TypeError('Paack requires the delivery postcode');
      }
      throw new TypeError(`${carrierDefinition(carrierId).displayName} requires the delivery postcode`);
    }
    switch (requirement.validator) {
      case 'planzerSharedUrl':
        supplied[field] = validatePlanzerSharedUrl(value, trackingNumber);
        break;
      case 'dachserCapabilityUrl':
        supplied[field] = validateDachserTrackingUrl(value, trackingNumber);
        break;
      case 'instaboxCapabilityUrl':
        supplied[field] = validateInstaboxTrackingUrl(value, trackingNumber);
        break;
      case 'freightwaysCapabilityUrl':
        supplied[field] = validateFreightwaysTrackingUrl(value, trackingNumber, carrierId);
        break;
      case 'swissPostcode':
        if (!/^\d{4}$/.test(value)) {
          throw new TypeError(
            `${carrierDefinition(carrierId).displayName} requires the four-digit delivery postcode`,
          );
        }
        break;
      case 'francePostcode':
      case 'germanyPostcode':
        if (!/^\d{5}$/.test(value)) {
          throw new TypeError(
            `${carrierDefinition(carrierId).displayName} requires the five-digit delivery postcode`,
          );
        }
        break;
      case 'swissOrFrancePostcode':
        if (!/^\d{4,5}$/.test(value)) {
          throw new TypeError(
            `${carrierDefinition(carrierId).displayName} requires a four- or five-digit delivery postcode`,
          );
        }
        break;
      case 'internationalPostcode':
        // The carrier delivers abroad too: any country's postcode, checked by the carrier itself.
        if (!DELIVERY_POSTCODE.test(deliveryPostcodeText(value))) {
          throw new TypeError(`${carrierDefinition(carrierId).displayName} requires a valid delivery postcode`);
        }
        supplied[field] = deliveryPostcodeText(value);
        break;
      case 'paackPostcode': {
        const rawPostcode = value.toLocaleUpperCase('en-US');
        if (!/^(?=.{3,10}$)(?=.*\d)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/.test(rawPostcode)) {
          throw new TypeError('Paack requires a valid delivery postcode');
        }
        supplied[field] = rawPostcode.replace(/\s+/g, '');
        break;
      }
      case 'colisPrivePostcode': {
        const normalized = colisPrivePostcode(value);
        if (!normalized) {
          throw new TypeError(`${carrierDefinition(carrierId).displayName} requires a French, Belgian or Luxembourg delivery postcode`);
        }
        supplied[field] = normalized;
        break;
      }
      default:
        requirement.validator satisfies never;
    }
  }
  return supplied;
}

/** A recipient postcode for universal providers; independent of a carrier's own credentials. */
export function normalizeDeliveryPostcode(value: string): string {
  const normalized = deliveryPostcodeText(value);
  if (!DELIVERY_POSTCODE.test(normalized)) {
    throw new TypeError('A valid delivery postcode is required');
  }
  return normalized;
}
