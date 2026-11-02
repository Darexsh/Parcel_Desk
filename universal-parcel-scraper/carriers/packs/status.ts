import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The sentences Packs' tracker writes in a shipment's status details and above
 * its progress rail, in `normalizeStatusWording` form without the closing
 * full stop, which the tracker writes for some and not others.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Announced by the sender, not yet scanned by Packs.
  ['uw zending is aangemeld', 'registered'],
  ['uw zending is aangemeld maar nog niet bij ons aangeboden', 'registered'],
  ['pakket aangemeld', 'registered'],
  // Collected at a regional Packscenter for the night's line haul; the next day's delivery window follows it.
  ['uw zending is gereed voor verzending naar ons landelijk sorteercentrum', 'accepted'],
  // A regional Packscenter, at either end of the journey.
  ['uw zending is aangekomen in het regionale packscenter', 'in_transit'],
  ['uw zending is bij ons sorteercentrum aangekomen', 'in_transit'],
  ['uw zending is in het sorteerproces', 'in_transit'],
  ['de bezorging is niet gelukt', 'failed_attempt'],
  ['uw zending is afgeleverd', 'delivered'],
]);

/** Planning notices: a delivery window given or changed, an instruction added. They move nothing. */
const NOTICES: readonly string[] = [
  'de zending heeft een tijdvak toegekend gekregen',
  'er is een nieuw tijdvenster aan deze zending toegekend',
  'er is een afleverinstructie aan de zending toegevoegd',
];
const NOTICE_SET: ReadonlySet<string> = new Set(NOTICES);

const key = (wording: string) => normalizeStatusWording(wording).replace(/[\s.!]+$/, '');

/** The stage Packs' map gives a sentence, or undefined for one it does not name. */
export function packsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A sentence's stage: the map's, nothing for a planning notice, else the shared wording rules'. */
export function packsStage(wording: string): ClassifiedWording | null {
  const mapped = packsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE_SET.has(key(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => packsMappedStage(wording),
  gaps: NOTICES.flatMap((wording) => [wording, `${wording}.`]).map((wording) => ({
    wording, note: 'A planning notice: a delivery window given or changed, or a delivery instruction added. It moves nothing.',
  })),
};
