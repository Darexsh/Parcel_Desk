/**
 * The clocks GOFO US dates its scans on, for a relay that keeps only a scan's
 * station and wall clock: Ship24's feed names the station GOFO gives
 * (`processLocation`), without its state, and writes the wall clock of the
 * zone GOFO gives it (`processTimeZone`). GOFO's own API names that zone on
 * every scan, which the adapter reads.
 */

/**
 * The stations GOFO named on the corpus's and benchmark's parcels, by the zone
 * it gave them (15 parcels, checked 2026-10-11). A delivery round is named
 * after the recipient's town and is left out: on all 15 it kept its delivery
 * station's zone.
 */
const STATION_ZONES: Readonly<Record<string, readonly string[]>> = {
  'America/New_York': ['Atlanta', 'Brooklyn', 'Carteret', 'Charleston', 'Cincinnati', 'Detroit', 'Doral', 'IND.H', 'Jamaica',
    'Miami', 'Milford', 'New York', 'Ocala', 'Orlando', 'Suwanee', 'VPC01'],
  'America/Chicago': ['Melrose Park'],
  // Newark is the Bay Area hub. ORD02.V picks up in Chicago, on Pacific time.
  'America/Los_Angeles': ['Chino', 'LAX.H', 'Los Angeles', 'Newark', 'ORD02.V', 'Portland', 'San Fernando Valley', 'San Francisco',
    'Seattle', 'Vernon'],
};

const STATIONS = new Map(Object.entries(STATION_ZONES).flatMap(([zone, names]) => names.map((name) => [name.toLowerCase(), zone])));

/** GOFO dates a label's creation on Pacific time wherever the parcel is (`processTimeZone` "US/Pacific" on all 15). */
const LABEL = /^shipping label created\b/i;

/** The zone of a GOFO US scan at `station`, worded `status`. Null for a name not listed, a delivery round's included. */
export function gofoScanZone(station: string, status: string): string | null {
  const name = station.trim().toLowerCase();
  if (name) return STATIONS.get(name) ?? null;
  return LABEL.test(status.trim()) ? 'America/Los_Angeles' : null;
}
