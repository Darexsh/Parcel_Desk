import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { comparableText } from './status.js';

/** Whether a row's location cell states the delivery instead of a depot: "Livré au destinataire". */
export function isDeliveryStatusCell(location: string): boolean {
  return comparableText(location) === 'livre au destinataire';
}

// Scans stored with that status as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd-fr', storedSources: ['dpd-fr'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isDeliveryStatusCell),
};
