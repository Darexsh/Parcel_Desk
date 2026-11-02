import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Universal providers copy SF's scans to the second, on the same UTC+08:00
// clock, in their own wording. The scan SF itself returns at that instant
// takes over the copy, and over its own row stored under older wording.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'sf-express', storedSources: ['sf-express', 'unknown'], requireProviderCode: false,
};
