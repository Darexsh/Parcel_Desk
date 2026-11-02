import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Bussgods' current status codes, named in the tracking page's script and
 * worded in its API documentation. The older codes below 7 are read by their
 * wording: the script and the documentation number them differently.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['7', 'in_transit'], // Registrerad (distribution): registered for distribution at the receiving end.
  ['10', 'ready_for_pickup'], // Anländ: arrived at the receiving agent, which texts the receiver. It also precedes a door delivery.
  ['11', 'accepted'], // Inlämnad: handed in at an agent or terminal.
  ['12', 'in_transit'], // Vidaresänd: forwarded towards the next station.
  ['13', 'delivered'], // Utlämnad: handed out to the receiver at the agent.
  ['14', 'delivered'], // Utkörd: delivered to the door.
  ['18', 'in_transit'], // På väg till ombud/kund: on the way to the agent or the customer.
  ['19', 'exception'], // Felsorterat, sändningen försenad: missorted and delayed.
  ['20', 'delivered'], // Utkörd: delivered to the door without a signature.
  ['21', 'failed_attempt'], // Utkörning misslyckades: the door delivery failed.
  ['22', 'in_transit'], // Loaded onto a vehicle.
  ['24', 'accepted'], // Inhämtad: collected from the sender.
  ['25', 'in_transit'], // Inhämtad hos ombud: collected from an agent.
]);

/** The wordings of the tracker and its documentation, for the older codes and any new code. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['registrerad', 'registered'],
  ['inlämnad', 'accepted'],
  ['inhämtad', 'accepted'],
  ['inhämtad hos ombud', 'in_transit'],
  ['vidaresänd', 'in_transit'],
  ['avsänd', 'in_transit'],
  ['registrerad (distribution)', 'in_transit'],
  ['på väg till ombud/kund', 'in_transit'],
  ['felsorterat, sändningen försenad', 'exception'],
  ['anländ', 'ready_for_pickup'],
  ['utlämnad', 'delivered'],
  ['utkörd', 'delivered'],
  ['utkörning misslyckades', 'failed_attempt'],
  ['retur', 'returned'],
]);

/** The stage Bussgods' map gives a status code and wording, in `normalizeStatusWording` form. */
export function bussgodsMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(wording);
}

/** A scan's stage: its code or wording, else the shared wording rules, else nothing. */
export function bussgodsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = bussgodsMappedStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

const PAID = 'A cash-on-delivery amount paid out to the sender; the parcel does not move.';
const RENUMBERED = 'The shipment was given a new number; the parcel does not move.';
const LEFT = 'Left at an agent, which can be the sender handing the parcel in or a driver leaving it on the way; it names no milestone of its own.';

export const statusMap: CarrierStatusMap = {
  stage: bussgodsMappedStage,
  gaps: [
    { code: '6', note: PAID },
    { code: '8', note: RENUMBERED },
    { code: '26', note: LEFT },
    { wording: 'utbetald', note: PAID },
    { wording: 'sändningen har fått nytt sändningsnummer', note: RENUMBERED },
    { wording: 'lämnad hos ombud', note: LEFT },
  ],
};
