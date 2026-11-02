# ANC Australian National Couriers

ANC (Australian National Couriers), the trading name of Fleets Flyers Pty. Limited, founded in 1921
and part of the Taylor Group since 1961, delivers big and bulky goods to homes for retailers in
Australia. Tracked through the open service its tracking page on ancdelivers.com.au asks.

## How it works

1. `direct`: one `GET https://api.ancdelivers.com.au/deliveries/{number}`, the request the tracking
   page makes. It needs no cookie, token, key or browser. The JSON reply, labelled as HTML, lists
   the delivery's steps in their order, each with its title and, once reached, its stamp.
2. `retry`: the same read once more when the service cannot be reached.

- A number the service does not hold gets HTTP 404 with `Delivery not found - {number}`, and a
  booking its depot system no longer keeps gets HTTP 404 with `HUB job cannot be found`; both are not
  found. Another 404, such as the server's page for a missing route, or a redirect is a moved
  service.
- The reply does not repeat the number; the not-found message must name the number asked.
- Recognition makes the same request.

## Notes

- The steps are the page's timeline: booked, scheduled, onboard for delivery, delivered, and a
  delivery attempt, a delay or a cancellation. Only steps with a stamp are scans. Their titles are
  staged by [`statuses.json`](statuses.json); a booking and its schedule are a registration, not a
  scan of the item.
- A stamp is a wall clock without a zone, so it stays `local_time`. The depot's zone is not stated,
  and Australia spans several.
- The steps keep the page's order: a schedule's stamp drops the seconds of the booking it shares a
  minute with.
- Each step's longer text names the driver, the delivered step carries the delivery's photos and
  signature inline, and the reply holds the recipient's address and contacts and the retailer's
  reference. The adapter reads none of them, nor the scheduled delivery date. The photos make a
  delivered booking's reply about a megabyte, so the read allows a few.

## Limitations

- No place, estimate, weight or delivery time as an instant.

## Numbers

Its numbers are A, eight digits and two letters; its help pages say to look for the number starting
with A. Three archived lookups on its tracker show that shape, all from one kind of source, so
`anc-delivers-1` suggests ANC at low confidence.

## Links

Tracking links carry the number in the path after `/track/`.

## Testing

`npm run test:carriers:live -- carriers/anc-delivers`, with `ANC_DELIVERS_TRACKING_NUMBER` and
optionally `ANC_DELIVERS_UNKNOWN_NUMBER` set outside the repository.
