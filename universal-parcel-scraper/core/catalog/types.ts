/**
 * Catalog vocabulary.
 *
 * What it is: the shape of a merged `carrier.json` entry and the typed views
 * the application consumes (carrier info, capabilities, input requirements,
 * tracking links).
 * What it is not: no data, no behaviour and no provider I/O; every declaration
 * here is erased at build time.
 */
import type { CarrierId } from '../../generated/catalog.js';
import type { DetectionConfidence } from '../detection/types.js';

export type CarrierTrackingMode = 'automatic' | 'link-only';
export type CarrierInputField = 'trackingUrl' | 'postcode';
export type CarrierInputValidator =
  | 'planzerSharedUrl'
  | 'dachserCapabilityUrl'
  | 'instaboxCapabilityUrl'
  | 'freightwaysCapabilityUrl'
  | 'swissPostcode'
  | 'francePostcode'
  | 'germanyPostcode'
  | 'swissOrFrancePostcode'
  | 'internationalPostcode'
  | 'paackPostcode'
  | 'colisPrivePostcode';

/** What the "add a parcel" forms render for a carrier that needs extra input. */
export interface CarrierInputRequirement {
  field: CarrierInputField;
  whenTrackingNumber?: string;
  /** The form may be submitted without it; a supplied value is still checked. */
  optional?: boolean;
  /**
   * An optional input the carrier shows more of the parcel with, whatever else answers: a
   * parcel saved without it is worth asking for it. Unset where the carrier needs it for only
   * some parcels of the shape and asks for those.
   */
  showsMore?: boolean;
  /**
   * The lookup reads the country the postcode is from (`postcodeCountry`), so it is worth naming
   * beside the postcode. Unset where the carrier reads the postcode alone.
   */
  readsCountry?: boolean;
  label: string;
  type: 'text' | 'url';
  placeholder?: string;
  help?: string;
  pattern?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'text' | 'url';
  autoComplete?: string;
}

/** What the server checks that extra input against. */
export interface CarrierRequirementRule {
  field: CarrierInputField;
  validator: CarrierInputValidator;
  whenTrackingNumber?: string;
  optional?: boolean;
}

export interface CarrierCatalogRequirement
  extends CarrierInputRequirement, CarrierRequirementRule {}

export interface CarrierCapabilities {
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    requirements: CarrierInputRequirement[];
  };
  selectable: boolean;
  timezone: string;
}

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Other names the carrier is known by, searched by the carrier pickers. */
  aliases: readonly string[];
  /** ISO codes of the countries it delivers in under its own name, home first. */
  countries: readonly string[];
  trackingSiteName?: string;
  /** Accent used for the carrier chip in the UI. */
  color: string;
  trackingUrl?: (trackingNumber: string) => string;
  /** The carrier's public page for typing a tracking number in, linked when the number is hidden. */
  trackingSearchUrl?: string;
  /** The carrier's official help and contact page for someone receiving a parcel, linked when it stops moving. */
  helpUrl?: string;
  /** Whether the carrier's tracking leaves out the number's journey in the destination country. */
  hidesDestinationLeg?: (trackingNumber: string) => boolean;
  capabilities: CarrierCapabilities;
}

export interface DetectionRule {
  pattern: string;
  /** Additional condition on the input before separators are removed. */
  rawPattern?: string;
  confidence: Exclude<DetectionConfidence, 'none'>;
  checksum?:
    | 's10' | 'mondial-relay' | 'hermes' | 'gls' | 'dhl-express' | 'tnt' | 'poczta-polska' | 'correos-spain' | 'dpd' | 'usps' | 'sscc'
    | 'ups' | 'colissimo' | 'ukrposhta' | 'evri' | 'mod7' | 'gs1' | 'ontrac' | 'luhn' | 'fedex' | 'sf-express'
    | 'fedex-ground-96' | 'fedex-1d' | 'identcode' | 'fedex-ground-economy' | 'pos-laju' | 'saia' | 'magyar-posta' | 'poste-italiane'
    | 'frankier-id' | 'dhl-ecommerce-pl';
  /** Low confidence only: number evidence that lists this carrier first among suggestions. */
  preferred?: boolean;
}

/** A link rule as it is written in the catalog, before its regexes compile. */
export interface RawTrackingLinkRule {
  domains: readonly string[];
  params?: readonly string[];
  /** Capture a number from the whole query, for portals without named parameters. */
  query?: string;
  /** Capture a number from the path; a path it does not capture from yields none. */
  path?: string;
  /** Limit the rule to the paths it matches, for pasted and partner links alike. */
  pathPattern?: string;
  fragment?: string;
  detectFromNumber?: boolean;
  /**
   * Name the carrier only for a number its own detection rules offer. Any other
   * number the link holds is detected on its own.
   */
  ownNumbersOnly?: boolean;
  keepsCapabilityUrl?: boolean;
}

/** One merged catalog entry: everything the app knows about a carrier. */
export interface CarrierDefinition {
  displayName: string;
  displayNames?: Record<string, string>;
  aliases?: readonly string[];
  countries?: readonly string[];
  trackingSiteName?: string;
  color: string;
  selectable: boolean;
  timezone: string;
  canaryUrl?: string;
  tracking: {
    mode: CarrierTrackingMode;
    adapter: string | null;
    upstreamName?: string;
    requirements?: readonly CarrierCatalogRequirement[];
    /** Present when the adapter can recognize a number; higher is asked first. */
    recognitionRank?: number;
    /** The normalized numbers recognition can answer; others the carrier's rules offer are not asked. */
    recognitionPattern?: string;
    /** Recognition asks the carrier only when the caller's country hint is one of its countries. */
    recognitionServedCountriesOnly?: boolean;
    /** Opt-in browser confirmation; higher is asked first after HTTP is inconclusive. */
    browserRecognitionRank?: number;
    refresh?: { minMinutes: number; afterFailureMinutes?: number };
    localClocks?: boolean;
    /** Every scan the adapter dates by its day alone is one the carrier gives no clock by design. */
    dateOnlyScans?: boolean;
    /** A lookup can open a browser: the private browser service or a local or remote Chromium. */
    browser?: boolean;
  };
  trackingUrlTemplate?: string;
  trackingSearchUrl?: string;
  helpUrl?: string;
  /** Regular expression matched against the normalized number. */
  hidesDestinationLeg?: string;
  linkRules: readonly RawTrackingLinkRule[];
  detectionRules: readonly DetectionRule[];
}
