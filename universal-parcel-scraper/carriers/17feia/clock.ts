import { countryTimeZone } from '../../core/time/index.js';

/** 17FEIA's backend keeps the order data and its warehouse's steps before the flight on Beijing time. */
export const SEVENTEENFEIA_HOME_ZONE = 'Asia/Shanghai';

/**
 * The words of the order data and of the steps at the warehouse in China before
 * the flight, which the parser reads on Beijing time by their label or place.
 */
const HOME_WORDINGS: ReadonlySet<string> = new Set([
  'item information received.', 'warehouse receipt.', 'the package is on the way to the facility.',
  'the order has information pending customer confirmation.', 'order confirmed.',
  'order dispatched from warehouse.', 'export declaration in progress.',
]);

/**
 * The zone of a copy of a 17FEIA row that kept its words but not its label or
 * country (Ship24's "Order Confirmed., OTHER"): Beijing for the order data and
 * the warehouse's steps, and for a relayed scan the clock of the single-zone
 * country its place ends with ("Hamm (DE)"). Null otherwise: the flight's and
 * customs' milestones keep their wall clocks, as the parser leaves them.
 */
export function seventeenFeiaCopyZone(wording: string, location: string): string | null {
  const country = /\(([A-Z]{2})\)$/.exec(location.trim())?.[1];
  if (country) return countryTimeZone(country);
  return HOME_WORDINGS.has(wording.trim().toLowerCase()) ? SEVENTEENFEIA_HOME_ZONE : null;
}
