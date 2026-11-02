import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// DealerSend files its own rows under a GUID status; the rows it relays from a delivering partner keep the partner's numeric code.
const OWN_STATUS = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Whether a row's status is one of DealerSend's own, rather than a partner's code. */
export const isDealerSendStatus = (code: string | null): boolean => code !== null && OWN_STATUS.test(code);

const wordings = (own: boolean) => new Map<string, Stage>(statuses.entries
  .filter((entry) => isDealerSendStatus(entry.code) === own)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const OWN = wordings(true);
// The partners' codes mean different steps on different lines (30 is a delivery round on a US line and
// processing in Canada), so their rows are read by their wording.
const RELAYED = wordings(false);

/**
 * The stage DealerSend's map gives a row by its `normalizeStatusWording`
 * wording: its own rows', whatever their GUID, and the partners' rows'. Both
 * use some of the same words for different steps: DealerSend's "arrived at
 * origin facility" is its acceptance in Hong Kong, a US partner's the first
 * scan after the flight. A row relayed without its code takes the partner's
 * reading of such words, so that a later scan never reads as the acceptance.
 */
export function dealerSendMappedStage(code: string | null, wording: string): Stage | undefined {
  if (isDealerSendStatus(code)) return OWN.get(wording);
  return RELAYED.get(wording) ?? (code === null ? OWN.get(wording) : undefined);
}

/**
 * A row's stage: the map's, else the shared rules on its wording. A partner
 * takes the parcel after DealerSend had it in Hong Kong, so the pickup or
 * acceptance a partner's code words is the journey going on. Null when
 * nothing reads it.
 */
export function dealerSendStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = dealerSendMappedStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  if (worded.source === 'none') return null;
  return code !== null && !isDealerSendStatus(code) && worded.stage === 'accepted' ? { stage: 'in_transit', source: 'carrier_map' } : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = dealerSendStage(code, wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
