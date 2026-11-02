import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { posteItalianeMovementWordings } from './status.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('it-IT');
const TOWN = / \([A-Z]{2}\)$/;

// Poste scans have no code. A depot scan stored before its town and province
// were read gains them in place, and one stored with the town and province
// alone gains the country after them; its wording still names the same scan.
// A registered-mail movement stored as the bare end of its sentence now reads
// with its box's label in front.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(wording)
    && [stored.description, ...posteItalianeMovementWordings(stored.description)].some(saved => normalized(saved) === wording)
    && (location === savedLocation || (TOWN.test(savedLocation) && location === `${savedLocation}, IT`)
      || (!savedLocation && / \([A-Z]{2}\), IT$/.test(location)));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'poste-italiane', storedSources: ['poste-italiane'], requireProviderCode: false, matchEachScan: true, matches,
};
