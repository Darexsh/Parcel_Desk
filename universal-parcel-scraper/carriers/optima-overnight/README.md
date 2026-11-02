# Optima Overnight

Optima Overnight (Optima Courier, Inc.) is a next-day last-mile carrier in Massachusetts,
Connecticut, Rhode Island and New Hampshire. Its site is shipoptima.com; optimacourier.com
redirects there.

## How it works

1. `direct`: one `GET https://distribution.shipoptima.com/api/shipment/tracking?trackingNumber={number}`,
   the lookup its tracking page makes. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the lookup or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- A number the lookup does not know gets HTTP 404 with status `NOT_FOUND` and a message
  quoting the number, read as not found. A 404 without them is a moved route, a redirect is
  too, a 403 or a firewall page in place of the JSON is a challenge, and a 429 is a rate limit.
- One of the shipment's packages must carry the whole number asked.
- Recognition makes the same request.

## Notes

- Each status is Optima's wording and a wall clock to the second with no zone, oldest first.
  The status map stages the wordings its tracking page lists; times stay `local_time`, and
  consumers fall back on the catalog's New York clock.
- A shipment Optima has not received yet has the status `Created` and no history; it is read
  from that status alone.
- The delivery address, the signatory, the delivery photos and each status's note are not read.

## Limitations

- No places, instants or expected delivery.

## Numbers

Its tracking numbers are `P` and fourteen digits, as two numbers its own tracking page carried
in archived captures show. `optima-overnight-1` suggests it at low confidence:
[TransMission](../transmission/README.md)'s rule takes the same layout.

## Links

The tracking page opens a number from its `tracking` parameter; its older form used
`trackingNumber`.

## Testing

`npm run test:carriers:live -- carriers/optima-overnight`, with `OPTIMA_OVERNIGHT_TRACKING_NUMBER`
and optionally `OPTIMA_OVERNIGHT_UNKNOWN_NUMBER` set outside the repository.
