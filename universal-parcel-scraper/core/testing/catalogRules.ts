/**
 * The catalog's detection rules, replayed one by one.
 *
 * What it is: every `carriers/<id>/carrier.json` rule read straight from disk
 * and matched the way the engine gates it, pattern first, then the checksum.
 * The detection sweep checks the engine against this replay, and the
 * expectation refresh declares the overlaps it finds.
 * What it is not: not the engine. It reads no generated catalog and picks no
 * carrier.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isValidColissimoParcelNumber } from '../detection/colissimo.js';
import { isValidEvriParcelNumber } from '../detection/evri.js';
import { isValidFedEx1DBarcode, isValidFedExGround96Barcode, isValidFedExGroundEconomyNumber } from '../detection/fedex.js';
import { isValidDhlEcommercePolandNumber, isValidDhlIdentcode } from '../detection/identcode.js';
import {
  isValidCorreosSpainCheckLetter,
  isValidDpdParcelNumber,
  isValidDhlExpressWaybill,
  isValidGlsParcelNumber,
  isValidHermesParcelNumber,
  isValidMondialRelayBarcode,
  isValidPocztaPolskaBarcode,
  isValidS10TrackingNumber,
  isValidSscc,
  isValidTntConsignmentNumber,
  normalizeTrackingNumber,
} from '../detection/index.js';
import {
  hasGs1CheckDigit,
  hasLuhnCheckDigit,
  hasMod7CheckDigit,
  isValidFedExTrackingNumber,
  isValidPosteItalianeRegisteredNumber,
  isValidSaiaPro,
  isValidUkrposhtaBarcode,
} from '../detection/numericChecksums.js';
import { isValidMagyarPostaNumber } from '../detection/magyarPosta.js';
import { isValidPosLajuConsignment } from '../detection/s10.js';
import { isValidSfExpressWaybill } from '../detection/sfExpress.js';
import { isValidOnTracTrackingNumber, isValidUpsTrackingNumber } from '../detection/ups.js';
import { isValidUspsPackageBarcode } from '../detection/usps.js';
import { CARRIERS_DIRECTORY, carrierFolders } from './corpus.js';

export interface DetectionRule {
  readonly id: string;
  readonly pattern: string;
  readonly rawPattern?: string;
  readonly confidence: 'high' | 'low';
  readonly checksum?:
    | 's10' | 'mondial-relay' | 'hermes' | 'gls' | 'dhl-express' | 'tnt' | 'poczta-polska' | 'correos-spain' | 'dpd' | 'usps' | 'sscc'
    | 'ups' | 'colissimo' | 'ukrposhta' | 'evri' | 'mod7' | 'gs1' | 'ontrac' | 'luhn' | 'fedex' | 'sf-express'
    | 'fedex-ground-96' | 'fedex-1d' | 'identcode' | 'fedex-ground-economy' | 'pos-laju' | 'saia' | 'magyar-posta' | 'poste-italiane'
    | 'dhl-ecommerce-pl';
  readonly preferred?: true;
}

export interface CarrierRule {
  readonly carrier: string;
  readonly rule: DetectionRule;
}

export const RULES: CarrierRule[] = carrierFolders().flatMap((carrier) => {
  const definition = JSON.parse(
    readFileSync(path.join(CARRIERS_DIRECTORY, carrier, 'carrier.json'), 'utf8'),
  ) as { detection?: DetectionRule[] };
  return (definition.detection ?? []).map((rule) => ({ carrier, rule }));
});

/** The engine's own gate, rule by rule: pattern first, then the checksum. */
function ruleMatches(rule: DetectionRule, value: string, raw: string): boolean {
  if (!new RegExp(rule.pattern).test(value)) return false;
  if (rule.rawPattern && !new RegExp(rule.rawPattern).test(raw.trim().toUpperCase())) return false;
  if (rule.checksum === 's10') return isValidS10TrackingNumber(value);
  if (rule.checksum === 'mondial-relay') return isValidMondialRelayBarcode(value);
  if (rule.checksum === 'hermes') return isValidHermesParcelNumber(value);
  if (rule.checksum === 'gls') return isValidGlsParcelNumber(value);
  if (rule.checksum === 'dhl-express') return isValidDhlExpressWaybill(value);
  if (rule.checksum === 'tnt') return isValidTntConsignmentNumber(value);
  if (rule.checksum === 'poczta-polska') return isValidPocztaPolskaBarcode(value);
  if (rule.checksum === 'correos-spain') return isValidCorreosSpainCheckLetter(value);
  if (rule.checksum === 'dpd') return isValidDpdParcelNumber(value);
  if (rule.checksum === 'usps') return isValidUspsPackageBarcode(value);
  if (rule.checksum === 'sscc') return isValidSscc(value);
  if (rule.checksum === 'ups') return isValidUpsTrackingNumber(value);
  if (rule.checksum === 'colissimo') return isValidColissimoParcelNumber(value);
  if (rule.checksum === 'ukrposhta') return isValidUkrposhtaBarcode(value);
  if (rule.checksum === 'evri') return isValidEvriParcelNumber(value);
  if (rule.checksum === 'mod7') return hasMod7CheckDigit(value);
  if (rule.checksum === 'gs1') return hasGs1CheckDigit(value);
  if (rule.checksum === 'ontrac') return isValidOnTracTrackingNumber(value);
  if (rule.checksum === 'luhn') return hasLuhnCheckDigit(value);
  if (rule.checksum === 'fedex') return isValidFedExTrackingNumber(value);
  if (rule.checksum === 'sf-express') return isValidSfExpressWaybill(value);
  if (rule.checksum === 'fedex-ground-96') return isValidFedExGround96Barcode(value);
  if (rule.checksum === 'fedex-1d') return isValidFedEx1DBarcode(value);
  if (rule.checksum === 'identcode') return isValidDhlIdentcode(value);
  if (rule.checksum === 'fedex-ground-economy') return isValidFedExGroundEconomyNumber(value);
  if (rule.checksum === 'pos-laju') return isValidPosLajuConsignment(value);
  if (rule.checksum === 'saia') return isValidSaiaPro(value);
  if (rule.checksum === 'magyar-posta') return isValidMagyarPostaNumber(value);
  if (rule.checksum === 'poste-italiane') return isValidPosteItalianeRegisteredNumber(value);
  if (rule.checksum === 'dhl-ecommerce-pl') return isValidDhlEcommercePolandNumber(value);
  return true;
}

export function matchingRules(input: string): CarrierRule[] {
  const value = normalizeTrackingNumber(input);
  return RULES.filter(({ rule }) => ruleMatches(rule, value, input));
}

/** Carriers with at least one matching rule, in catalog order. */
export function matchingCarriers(input: string): string[] {
  return [...new Set(matchingRules(input).map(({ carrier }) => carrier))];
}

/**
 * The engine stops at a carrier's first matching rule, so a carrier's
 * confidence is that rule's confidence, not the strongest one it owns.
 */
export function highConfidenceCarriers(input: string): string[] {
  const matches = matchingRules(input);
  const firstPerCarrier = new Map<string, DetectionRule>();
  for (const { carrier, rule } of matches) if (!firstPerCarrier.has(carrier)) firstPerCarrier.set(carrier, rule);
  return [...firstPerCarrier.entries()]
    .filter(([, rule]) => rule.confidence === 'high')
    .map(([carrier]) => carrier);
}
