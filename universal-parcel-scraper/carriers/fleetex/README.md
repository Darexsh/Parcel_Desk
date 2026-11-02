# FleetExpress

FleetExpress is a Canadian last-mile courier that runs on Superroute's delivery platform. Tracked
through the public tracking feed its API publishes for 17TRACK, which holds the scans its
tracking page shows.

## How it works

1. `direct`: one `GET https://api.fleetexpress.ca/api/v1/17track/{number}`, a public endpoint
   of FleetExpress's API documentation. It needs no cookie, token, key or browser. The JSON
   reply names the parcel's number and lists its scans, oldest first, each with an instant, a
   message and sometimes a depot's name.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number the feed holds no parcel under is HTTP 200 with the notice `Tracking number not
  found`, which the adapter reads as `NotFoundError`. Another notice is a schema change; a 404
  or a redirect is a moved route. The documentation says cancelled orders are left out of
  tracking lookups, so they read as not found too.
- The reply must name the whole number asked; one for another parcel, including one found by
  the shipper's own reference, is inconclusive.
- Recognition makes the same request.

## Notes

- The tracking page, `tracking.fleetexpress.ca/tracking/{language}/{number}`, is drawn on the
  server and asks no API in the browser. The same API's other public lookup,
  `/api/v1/tracking/{number}`, gives the scans with codes, but its reply does not name the
  number, so it cannot be bound to the parcel asked, and it carries recipient details the feed
  leaves out.
- A scan's time carries the offset of the zone set on the shipper's account rather than of the
  scan's place: a Quebec scan has come with Sydney's offset. The instant is kept, in UTC.
- The feed capitalizes every word of a message, and the adapter keeps it so. Scans have no code;
  the platform's messages, from replies and from the API documentation's examples, stage them,
  with the shared wording rules for the rest.
- The feed's overall status, in 17TRACK's vocabulary, is not read: it is `InTransit` for an
  order whose only scan is its submitted details. The shipper's name and its own reference for
  the parcel are not read either.

## Numbers

FleetExpress's API documentation gives order tracking numbers of `SR` and twelve digits and a
package number of `DS` and twelve digits, and the adapter takes only those. `SR` is the
platform's prefix rather than FleetExpress's own, and the same documentation uses it for test
numbers of other lengths, so no rule claims either layout. One documentation example the
tracker knows is kept out of [`numbers.json`](numbers.json) because delivery photos are on file
for it.

## Links

The tracking forms on `fleetexpress.ca` and `tracking.fleetexpress.ca` open one parcel at
`tracking.fleetexpress.ca/tracking/{language}/{number}`, and the newer tracking page opens it at
`/oteptrack/{language}/{number}`. The library reads the number from either address.

## Limitations

- No package (`DS`) number has been seen in the feed; a reply that names the order's number
  instead of the package's is inconclusive.
- A parcel handed to another carrier is not followed: the feed names no partner network.
- No estimate, weight, service, sender, recipient, signatory or proof of delivery.

## Testing

`npm run test:carriers:live -- carriers/fleetex`, with `FLEETEX_TRACKING_NUMBER` and optionally
`FLEETEX_UNKNOWN_NUMBER` set outside the repository.
