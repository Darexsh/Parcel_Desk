# Estes

Tracks Estes Express Lines freight, the US less-than-truckload carrier, through the service its
MyEstes tracking page asks.

## How it works

The shipment tracking page at `www.estes-express.com/myestes/shipment-tracking/` asks
`GET https://myestes-api.estes-express.com/shipmenttracking/history?pro={number}`, without an
account, key, cookie or CAPTCHA token; the page adds a token only after a login. The adapter sends
the same GET. A request that fails to reach Estes is sent once more within the budget.

A known PRO number gets HTTP 200 with the shipment. An unknown one gets HTTP 404 with the service's
code `50010`, the only missing shipment, and a number the service does not take gets HTTP 400 with
its code `20010`. Any other 404 or 410, a 400 without its code, or an answer for another PRO number
stays inconclusive, as does an answer without a shipment, which the page reads as "information
received, check back later". Block pages, rate limits and other HTTP errors keep their own failure
kinds. Recognition uses the same lookup.

The developer portal's account API, which this adapter does not use, documents the same reply and
Estes's reason code tables.

## Numbers

A PRO number is ten digits; the service refuses any other length, so anything else is invalid
without a request. Spaces, dots and dashes are dropped. Ten digits are shared with several
carriers and Estes publishes no check digit, so detection offers no Estes rule and recognition is
not asked for them; Estes tracking runs when the caller names the carrier.

## Notes

- The reply holds the shipment's current status and its movements: the pickup, the terminals it
  passes and the delivery, each with status rows. Rows are read newest first by instant, rows
  stamped alike keep the later-listed one first, and identical rows are kept once. Every clock
  carries its offset. The current status is added as a scan when it is newer than every row; with
  no row yet, the answer is that status alone.
- A row's stage comes from its reason code, then its wording, then its exception flag, then its
  milestone; codes and wordings are mapped in [status.ts](status.ts). Estes files refused,
  returned and undelivered stops, and freight handed to an interline partner or a broker, under
  its Delivered milestone, so the milestone decides only when nothing else does. The pickup tables
  reuse delivery codes with other meanings, so pickup rows are read by their wording; an attempted
  pickup leaves the freight with the shipper.
- Only terminal movements, whose id is the terminal's number, get a place: the terminal's town and
  state. The pickup and delivery movements stand for the shipper's and the consignee's premises.
  The terminal's address keeps fifteen characters of the town; when the terminal's name continues
  it, the name is used.
- The weight is the shipment's total in pounds, given in kilograms. The estimate is a day or a
  period of days and is dropped once the freight is delivered or returned. The delivery time is
  the shipment's own.
- The reply also carries the consignee and shipper, the person who signed, the driver, the
  appointment, references, documents, the pieces and cube, the terminals' streets, phones and
  emails, and coordinates from the drivers' handhelds. None of them is read.

## Limitations

When Estes hands freight to an interline or final delivery partner, the adapter names neither the
partner nor its number.

## Links

The home page's tracking form opens `www.estes-express.com/myestes/shipment-tracking/?type=PRO&query={number}`,
which fills the page's field in with the number. The library reads no number from these links:
the same `query` carries bills of lading and purchase orders under other types.

## Live test

Set `ESTES_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/estes/adapter.live.test.ts`.
Optionally set `ESTES_UNKNOWN_NUMBER` to check a PRO number Estes does not know.
