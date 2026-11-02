/**
 * The checksums a detection rule can name.
 *
 * What it is: the one table from a rule's `checksum` id to its validator. The
 * engine dispatches through it, and the checksum test vectors are generated
 * from it.
 * What it is not: no pattern matching and no carrier choice. Each validator
 * receives the normalized number.
 */
import type { DetectionRule } from '../catalog/types.js';
import { isValidColissimoParcelNumber } from './colissimo.js';
import { isValidCorreosSpainCheckLetter } from './correosSpain.js';
import { isValidDpdParcelNumber } from './dpd.js';
import { isValidEvriParcelNumber } from './evri.js';
import { isValidFedEx1DBarcode, isValidFedExGround96Barcode, isValidFedExGroundEconomyNumber } from './fedex.js';
import { isValidFrankierId } from './frankierId.js';
import { isValidGlsParcelNumber } from './gls.js';
import { isValidHermesParcelNumber } from './hermes.js';
import { isValidDhlEcommercePolandNumber, isValidDhlIdentcode } from './identcode.js';
import { isValidMagyarPostaNumber } from './magyarPosta.js';
import { isValidMondialRelayBarcode } from './mondialRelay.js';
import {
  hasGs1CheckDigit,
  hasLuhnCheckDigit,
  hasMod7CheckDigit,
  isValidDhlExpressWaybill,
  isValidFedExTrackingNumber,
  isValidPocztaPolskaBarcode,
  isValidPosteItalianeRegisteredNumber,
  isValidSaiaPro,
  isValidSscc,
  isValidTntConsignmentNumber,
  isValidUkrposhtaBarcode,
} from './numericChecksums.js';
import { isValidPosLajuConsignment, isValidS10TrackingNumber } from './s10.js';
import { isValidSfExpressWaybill } from './sfExpress.js';
import { isValidOnTracTrackingNumber, isValidUpsTrackingNumber } from './ups.js';
import { isValidUspsPackageBarcode } from './usps.js';

export type ChecksumId = NonNullable<DetectionRule['checksum']>;

export const CHECKSUMS: Readonly<Record<ChecksumId, (trackingNumber: string) => boolean>> = {
  'mondial-relay': isValidMondialRelayBarcode,
  s10: isValidS10TrackingNumber,
  hermes: isValidHermesParcelNumber,
  gls: isValidGlsParcelNumber,
  'dhl-express': isValidDhlExpressWaybill,
  tnt: isValidTntConsignmentNumber,
  'poczta-polska': isValidPocztaPolskaBarcode,
  'correos-spain': isValidCorreosSpainCheckLetter,
  dpd: isValidDpdParcelNumber,
  usps: isValidUspsPackageBarcode,
  sscc: isValidSscc,
  ups: isValidUpsTrackingNumber,
  colissimo: isValidColissimoParcelNumber,
  ukrposhta: isValidUkrposhtaBarcode,
  evri: isValidEvriParcelNumber,
  mod7: hasMod7CheckDigit,
  gs1: hasGs1CheckDigit,
  ontrac: isValidOnTracTrackingNumber,
  luhn: hasLuhnCheckDigit,
  fedex: isValidFedExTrackingNumber,
  'sf-express': isValidSfExpressWaybill,
  'fedex-ground-96': isValidFedExGround96Barcode,
  'fedex-1d': isValidFedEx1DBarcode,
  identcode: isValidDhlIdentcode,
  'fedex-ground-economy': isValidFedExGroundEconomyNumber,
  'pos-laju': isValidPosLajuConsignment,
  saia: isValidSaiaPro,
  'magyar-posta': isValidMagyarPostaNumber,
  'poste-italiane': isValidPosteItalianeRegisteredNumber,
  'frankier-id': isValidFrankierId,
  'dhl-ecommerce-pl': isValidDhlEcommercePolandNumber,
};
