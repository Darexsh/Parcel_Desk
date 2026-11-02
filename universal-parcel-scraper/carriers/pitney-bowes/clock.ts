/**
 * The scans Pitney Bowes's platform writes without a place when its UK hub
 * processes a parcel for Interpost, each at the instant of the hub's
 * processing scan: its own "In Transit" and Interpost's processing on UTC, an
 * hour before the hub's scan in British summer time, and Interpost's hand-over
 * to the postal company on a fixed UTC+2, two hours after Interpost's
 * processing in winter as in summer. Central European time put the hand-over
 * an hour after the hub's scan in winter.
 */
const PLATFORM_CLOCKS: ReadonlyMap<string, string> = new Map([
  ['in transit', 'UTC'],
  ['item processed at interpost', 'UTC'],
  ['interpost handed item over to postal company', 'Etc/GMT-2'],
]);

/** The clock of a scan the platform writes without a place, by its wording. */
export function pitneyBowesPlatformClock(wording: string): string | undefined {
  return PLATFORM_CLOCKS.get(wording.trim().toLowerCase());
}

/**
 * The destination post's scans that Pitney Bowes relays without a place once
 * Interpost has handed the parcel over. They keep that post's clock: on a
 * parcel to Italy, the round and the delivery have the digits of Poste
 * Italiane's own instants on Rome time.
 */
const POSTAL_RELAYS = new Set([
  'item in transit by postal company', 'parcel is out for delivery', 'item is waiting for addressee at local post office',
  'delivered by consignee pickup', 'item has been delivered',
]);

/** Whether a wording is the destination post's scan, relayed on that post's clock. */
export function pitneyBowesPostalRelay(wording: string): boolean {
  return POSTAL_RELAYS.has(wording.trim().toLowerCase());
}
