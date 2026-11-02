import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';

/**
 * A depot's locality without the "PLAT" NACEX writes before a platform's town, cut to twelve
 * letters: "PLATMADRID" is its Madrid platform, "PLATJAEN" Jaén's. A beach town ("PLATJA D ARO")
 * keeps its name.
 */
export function nacexPlace(locality: string): string {
  return locality.replace(/^PLAT ?(?!JA\b)(?=\p{Lu}{3})/u, '');
}

// A platform's scan stored under the name with "PLAT" keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'nacex', storedSources: ['nacex'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesRereadLocation(incoming, stored, nacexPlace),
};
