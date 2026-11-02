import { freightwaysAdapter, freightwaysApi } from '../nz-couriers/freightways.js';
import { NOW_COURIERS } from './parser.js';

/** The Freightways lookup under Now Couriers' name, which its receiver site's script asks. */
export const NOW_COURIERS_API = freightwaysApi(NOW_COURIERS);

export const adapter = freightwaysAdapter(NOW_COURIERS);
