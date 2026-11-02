# Fixtures

Each file follows the reply of `/api/track/package-details/{number}`, newest scan first, with
the summary and shipping details the page reads.

- `delivered.json` goes from the uploaded label through the hub and the hand-over to the
  delivery by the destination's post. One hub scan is repeated, a partner's scan is relayed
  twice, once with its place and once without, one place has `XX` for its region, and the
  relayed scans link to the partner's page.
- `in-transit.json` stops at destination customs.
- `unknown.json` is the answer for a number the tracker does not know: `ServerError`, with no
  scans, as the page gives when it cannot read a parcel.

Numbers, places, links and clocks are invented.
