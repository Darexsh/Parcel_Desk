# Fixtures

The replies follow `getOrderTrace`'s JSON, as the tracking page's script reads it.

- `delivered.json` is a parcel booked at the warehouse, flown out and delivered abroad. Its
  scans are newest first, as the page lists them, and one is listed twice. One scan's place
  is an address, one has a postcode, one has no wording and one says nothing a rule stages,
  so the tests can show how each is read.
- `not-found.json` is the answer for a number the tracker does not have.

Numbers, clocks, places, wording and the status text are invented.
