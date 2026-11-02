import { freightwaysAdapter, freightwaysApi, FreightwaysTracker } from '../nz-couriers/freightways.js';
import { POST_HASTE } from './parser.js';

/**
 * The Freightways lookup under Post Haste's name, which Post Haste's receiver
 * site script carries. The tracking page on posthaste.co.nz asks it through
 * its web agency's proxy.
 */
export const POST_HASTE_API = freightwaysApi(POST_HASTE);

export class PostHasteTracker extends FreightwaysTracker {
  constructor(options: ConstructorParameters<typeof FreightwaysTracker>[1] = {}) { super(POST_HASTE, options); }
}

export const adapter = freightwaysAdapter(POST_HASTE);
