# Fermopoint

Fermopoint is an Italian network of shops where parcels wait for collection, part of BRT. A
shop can also send a parcel on with BRT. Tracked through the booking page the site's tracking
forms open.

## How it works

1. `direct`: one `GET https://www.fermopoint.it/prenotazione/{code}`, the page both tracking
   forms redirect to. It needs no cookie, token, key or browser. The HTML page heads the answer
   with the code, then lists the steps with their clocks, newest first.
2. `retry`: one more attempt after a network failure.

- A code without an active booking gets the page's "non ci risulta essere attivo" notice under
  the same heading, which is not found. A code that fails the page's own format check is
  redirected to its error page, which is invalid input. Any other redirect or a 404 is a moved
  route, and a firewall page is a challenge.
- The heading must name the code asked.
- Recognition makes the same request.

## Notes

- The steps are Fermopoint's own milestones, not the courier's scans: booked, prepared, on its
  way to the shop, arrived and collected. "In consegna" is the parcel on its way to the shop,
  so it stays in transit rather than out for delivery.
- Each clock is Fermopoint's wall clock to the second, with no zone. The network is Italian, so
  it is dated in Rome's zone; the hour the clocks repeat reads as its first occurrence.
- The page shows a booking's details only to the account that booked it. Without signing in it
  names neither the shop nor a BRT number, so there is no hand-off.
- The table repeats the current step in a row only small screens show; the adapter skips it.

## Limitations

- No shop, location, ETA, weight or courier number.

## Numbers

A collection booked with Fermopoint gets a 13-character Fermoticket: a letter, four letters or
digits, two letters and six digits, as the tracking page's example and archived lookups show.
A parcel sent from a shop gets a code of the same layout, as the shipping guide's example
receipt shows. `fermopoint-1` claims that layout with low confidence, because Paquetexpress's
rule takes some of the same codes. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`fermopoint.it/prenotazione/{number}` opens one booking. Archived lookups also use the former
`/fermoticket/` address, which now redirects there.

## Testing

`npm run test:carriers:live -- carriers/fermopoint`, with `FERMOPOINT_TRACKING_NUMBER` and
optionally `FERMOPOINT_SHIPMENT_NUMBER` and `FERMOPOINT_UNKNOWN_NUMBER` set outside the
repository.
