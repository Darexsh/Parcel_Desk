# Fixtures

Each file follows the reply of the tracking page's `/api/tracking` for one number, with the
entry's fields and its scans oldest first. `delivered.json` is a booked pickup delivered in
another zone: the pickup scans before the agent are in UTC and name no zone, Lion Parcel's own
scans carry an offset and name the site's zone, the destination's scans are in central
Indonesia, one scan is repeated, the pickup and delivery courier and the person who took the
parcel are named, and the delivery has a photo. `in-transit.json` waits at the destination's
warehouse in eastern Indonesia, after a flight it waited two days for and a price adjustment,
with a delivery window. `not-found.json` is the entry for a number the tracker does not know.

Numbers, names, places, booking codes, links and clocks are invented.
