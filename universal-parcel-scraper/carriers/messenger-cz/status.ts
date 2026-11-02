import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The shipment states of Messenger's API documentation, by name. The tracking
 * page's scans carry no state code, so the name stages a scan. `null` is a
 * state that moves nothing.
 */
const STATES: ReadonlyMap<string, Stage | null> = new Map([
  ['přijata', 'registered'], // The order was received.
  ['přiřazena', 'registered'], // Assigned to a courier, not yet collected.
  ['vyzvednuta', 'accepted'], // The courier collected the parcel.
  ['doručena do depa', 'in_transit'], // Reached the depot.
  ['vyskladněna', 'in_transit'], // Left the warehouse.
  ['v procesu', 'in_transit'], // On its way to the addressee.
  ['vyzvednuta z depa', 'out_for_delivery'], // A courier took it from the depot to deliver it.
  ['připravena k výdeji', 'ready_for_pickup'],
  ['marné doručení', 'failed_attempt'], // The customer was not reached; delivery will be tried again.
  ['nedoručena', 'failed_attempt'], // Delivery failed and will not be tried again.
  ['odmítl převzít', 'exception'], // The customer refused the parcel.
  ['nešlo vyzvednout', 'exception'], // The person handing it over was not reached.
  ['doručena', 'delivered'],
  ['vrací se zpět', 'returned'], // Going back to the sender after a failed delivery.
  ['stornovaná', 'exception'], // Cancelled without delivery; the documentation's example spells it `stornována`.
  ['stornována', 'exception'],
  ['avizované vyzvednutí', null],
  ['avizované doručení', null],
  ['uzavřena', null],
  ['chyba', null],
  ['fakturovaná', null],
  ['odebrána z faktury', null],
  ['odebrána', null],
]);
// Longest first, so a name that opens with a shorter one is read whole.
const NAMES = [...STATES.keys()].sort((left, right) => right.length - left.length);
const LETTER = /\p{L}/u;

/**
 * The documented state a scan's text opens with, as the text writes it, and
 * the rest after it. The documentation says what follows a state names who
 * took or handed over the parcel.
 */
export function messengerState(text: string): { name: string; rest: string } | null {
  const lower = text.normalize('NFC').toLocaleLowerCase('cs');
  for (const name of NAMES) {
    if (lower.startsWith(name) && !LETTER.test(lower.charAt(name.length))) {
      return { name: text.normalize('NFC').slice(0, name.length), rest: text.normalize('NFC').slice(name.length) };
    }
  }
  return null;
}

/** The stage a documented state's name gives, or undefined for another name. */
export function messengerMappedStage(name: string): Stage | undefined {
  return STATES.get(name.normalize('NFC').toLocaleLowerCase('cs')) ?? undefined;
}

/** A scan's stage: its documented state, else the shared wording rules, else nothing. */
export function messengerStage(wording: string): ClassifiedWording | null {
  const state = messengerState(wording);
  if (state) {
    const stage = messengerMappedStage(state.name);
    return stage ? { stage, source: 'carrier_map' } : null;
  }
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => messengerMappedStage(wording),
  gaps: [
    { wording: 'avizované vyzvednutí', note: 'The sender was told when the courier will collect; it moves nothing.' },
    { wording: 'avizované doručení', note: 'The recipient was told when the courier will deliver; it moves nothing.' },
    { wording: 'uzavřena', note: 'The order closed after its last event; it moves nothing.' },
    { wording: 'chyba', note: 'An error state the documentation gives no meaning.' },
    { wording: 'fakturovaná', note: 'The journey was invoiced; it moves nothing.' },
    { wording: 'odebrána z faktury', note: 'The journey was taken off an invoice; it moves nothing.' },
    { wording: 'odebrána', note: 'The order was taken from a courier before collection; it moves nothing.' },
  ],
};
