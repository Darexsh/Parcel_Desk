# Fixtures

Replies of the tracking form's lookup, `POST /wp-json/tealca-rastreo/v1/rastreo`, oldest scan
first as the service lists them. Every scan repeats the origin store's city and state.

- `delivered.json` goes from the guía's creation at the origin store through two platforms and
  the destination store to the delivery, whose wording names the person who took the parcel
  and an ID number. Two scans share one clock, and one platform scan is repeated.
- `in-transit.json` has reached its second platform; the summary status is still in transit.
- `not-found.json` is the answer for a number Tealca does not know.

Numbers, names, IDs, stores, places and clocks are invented.
