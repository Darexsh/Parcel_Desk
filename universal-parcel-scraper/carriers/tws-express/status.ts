import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's status codes (`codiceStato`). Only codes seen in replies are
 * mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['NV', 'registered'], // NUOVA: the sender created the waybill.
  ['CF', 'registered'], // CONFERMATA: the sender confirmed it; TWS has not scanned the parcel yet.
  ['PRT', 'accepted'], // IN PARTENZA TWS: TWS's first scan before the parcel leaves.
  ['THE', 'in_transit'], // IN TRANSITO
  ['PPP', 'in_transit'], // PARTITA: left the branch.
  ['HBS', 'in_transit'], // IN TRANSITO HUB
  ['GGG', 'out_for_delivery'], // IN CONSEGNA (MATT): the morning round.
  ['POM', 'out_for_delivery'], // IN CONSEGNA (POM): the afternoon round.
  ['008', 'failed_attempt'], // DESTINATARIO ASSENTE: the recipient was not in.
  ['SVO', 'in_transit'], // SVINCOLATA ONLINE: the recipient released a held parcel online; it goes out again.
  ['000', 'delivered'], // CONSEGNATA
]);

/** The same statuses by wording, for a scan without a code, as older lookups gave, or with a code not seen yet. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['NUOVA', 'registered'],
  ['CONFERMATA', 'registered'],
  ['IN PARTENZA', 'accepted'],
  ['IN PARTENZA TWS', 'accepted'],
  ['IN TRANSITO', 'in_transit'],
  ['PARTITA', 'in_transit'],
  ['IN TRANSITO HUB', 'in_transit'],
  ['IN CONSEGNA (MATT)', 'out_for_delivery'],
  ['IN CONSEGNA (POM)', 'out_for_delivery'],
  ['DESTINATARIO ASSENTE', 'failed_attempt'],
  ['SVINCOLATA ONLINE', 'in_transit'],
  ['CONSEGNATA', 'delivered'],
]);

// A parcel held at the branch, as "GIACENZA: : DESTINATARIO ASSENTE" under the
// code of the failed attempt that led to it, or "in giacenza".
const HELD = /^(?:IN )?GIACENZA\b/;
// CONSEGNE PARTICOLARI, logged after a round that delivered nothing, says
// neither what happened nor what comes next.
const SILENT = new Set(['029']);

const comparable = (text: string) => text.toUpperCase().replace(/\s+/g, ' ').trim();

/** The stage TWS's code, else its wording, gives a scan. */
export function twsMappedStage(code: string | null, wording: string): Stage | undefined {
  const text = comparable(wording);
  if (HELD.test(text)) return 'exception';
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(text);
}

/** A scan's stage: its code or wording, else the shared wording rules, else nothing. */
export function twsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = twsMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (SILENT.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => twsMappedStage(code, wording),
  gaps: [
    { code: '029', note: 'CONSEGNE PARTICOLARI follows a round that delivered nothing, without saying what happened or what comes next.' },
  ],
};
