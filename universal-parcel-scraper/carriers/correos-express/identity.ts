import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { classifyCorreosExpressDescription, correosExpressDescriptionLabel, correosExpressSituationKey } from './status.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-ES');
// The neutral wording a scan with an unrecognized label is stored under.
const NEUTRAL = 'TRACKING UPDATE';

// A scan stored under the neutral wording before its label was recognized
// takes its label and stage in place, and one stored without the fixed
// explanation of its label takes it; the town still names the same scan. A
// scan stored in Spanish takes its Portuguese wording in place, and the
// reverse: both pages show one history with the same clocks and places, and
// the label names the same situation in both. Apps store only scans with an
// instant, which a Correos Express scan has when its locality settles its clock.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const location = normalized(incoming.location);
  if (location !== normalized(stored.location)) return false;
  const wording = normalized(incoming.description);
  if (!wording) return false;
  if (wording === normalized(stored.description)) return true;
  if (classifyCorreosExpressDescription(incoming.description) === undefined) return false;
  const situation = (scan: SameInstantScan) => correosExpressSituationKey(correosExpressDescriptionLabel(scan.description));
  return normalized(stored.description) === NEUTRAL || situation(incoming) === situation(stored);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'correos-express', storedSources: ['correos-express'], requireProviderCode: false,
  matchEachScan: true, matches,
};
