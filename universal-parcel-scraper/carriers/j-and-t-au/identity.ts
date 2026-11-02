import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

// The courtesy some sentences close with, whose customer service number the
// adapter drops: "If you have any questions, please call, Thank you for your
// patience.", "If you have any questions,please call. We look forward to serving you again."
const COURTESY = /\s*If you have any questions\s*,\s*please call\b.*$/isu;

/** A scan's sentence without the courtesy it closes with. */
export function withoutCourtesy(sentence: string): string {
  return sentence.replace(COURTESY, '');
}

const wording = (description: string) => description.replace(/\s+/g, ' ').trim();

/** The same scan stored with the courtesy its sentence now leaves out. */
function lostCourtesy(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const sentence = wording(incoming.description);
  return Boolean(sentence) && sentence !== wording(stored.description) && sentence === wording(withoutCourtesy(stored.description))
    && incoming.stage === stored.stage && incoming.location.trim() === stored.location.trim();
}

// A scan stored with that courtesy keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'j-and-t-au', storedSources: ['j-and-t-au'], requireProviderCode: false,
  matchEachScan: true,
  matches: lostCourtesy,
};
