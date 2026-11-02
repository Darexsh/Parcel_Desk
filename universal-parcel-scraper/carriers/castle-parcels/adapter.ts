import { freightwaysAdapter, freightwaysApi } from '../nz-couriers/freightways.js';
import { CASTLE_PARCELS } from './parser.js';

/** The Freightways lookup under Castle Parcels' name, which its receiver site's script asks. */
export const CASTLE_PARCELS_API = freightwaysApi(CASTLE_PARCELS);

export const adapter = freightwaysAdapter(CASTLE_PARCELS);
