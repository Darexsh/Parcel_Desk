import { speedyIdentityPolicy } from '../speedy/identity.js';

// DPD Romania's places are Speedy's, and lost their site's type with them.
export const sameInstantIdentityPolicy = speedyIdentityPolicy('dpd-ro');
