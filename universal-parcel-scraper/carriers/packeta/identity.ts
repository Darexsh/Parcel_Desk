import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { packetaEventText, packetaPlacedText } from './text.js';

// Hand-off scans stored with their partner link's markup read the same
// sentence without it, at the same instant. A scan stored with its depot or
// point in the sentence reads it as its place.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'packeta', storedSources: ['packeta'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => {
    if (incoming.description === '') return false;
    const sentence = packetaEventText(stored.description);
    if (incoming.location === stored.location) return incoming.description === sentence;
    const placed = packetaPlacedText(sentence);
    return stored.location === '' && incoming.location === placed.location && incoming.description === placed.description;
  },
};
