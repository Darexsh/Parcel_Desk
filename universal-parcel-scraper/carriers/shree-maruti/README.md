# Shree Maruti Courier

Shree Maruti Courier Services is a domestic courier and parcel network in India. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://apis-hubops.innofulfill.com/tracking/v2/{number}`, the request
   the tracker at `tracking.shreemaruti.com` makes. It needs no cookie, token, key, captcha or
   browser. The JSON reply has the order and its rows, newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with `[]`, or with no order and no rows, for which the page
  shows nothing. A 404 or a redirect is a moved route. A 403 is reported as a challenge.
- The service allows a client 120 lookups a minute and answers more with HTTP 429; its
  `Retry-After` or `X-RateLimit-Reset` gives the wait.
- The order must name the number asked, and a row is kept only when one of its number fields
  does: the service's own, the client's or the hub system's. Rows filed under another number
  are left out, and a reply with none of the number's own is inconclusive.
- Recognition makes the same request.

## Notes

- `statusTimestamp` is epoch milliseconds, and the tracker shows every row at that instant. A
  row the service stored from ten minutes before its clock to two days after it was recorded as
  it happened or synced late, so it is an instant, given in India's zone.
- Deliveries copied in weeks later hold the delivering branch's Indian wall clock stored as if
  it were UTC. Read as instants, as the tracker shows them, they fall more than five hours after
  the live delivery they repeat; their digits fall minutes before it. No field marks a copy, so
  a row stored further from its clock keeps those digits as `local_time`, without an offset, and
  is ordered as Indian time.
- Each row gets the label the tracker gives its code. The tracker shows every hub, bag and
  dispatch scan as In Transit, and a courier booking's confirmation as Shipment Confirmed. An
  unknown code is read by its category, then by its shape (a scan or bag movement, a delivery,
  a code of the way back), then by its own words.
- A movement on the way back to the sender is part of the return and reads Return In Transit.
- An attempt, a hold or a return is followed by the reason the row gives, as in
  `Delivery Attempted: Consignee not available`, without phone numbers.
- Bookkeeping rows (data updates, reconciliations, verifications) are left out, as the page
  does.
- A row's location is the hub or branch that scanned it. The dispatch row names the sender's
  address instead, so it and any location with a comma or a PIN code are left out, as is the
  placeholder `default`.
- The reply carries the recipient's and sender's names, phones and addresses, the delivery
  agent's name and phone and links to proof-of-delivery images. None of them are kept.
- The site's support form looks numbers up through `apis.delcaper.com/tracking/v2/{number}`,
  which answers the same rows with a higher rate limit. The adapter uses the tracker's own
  host.

## Limitations

- No delivery estimate, weight, service name or proof of delivery.
- The lookup knows only recent dockets. Older ones, including the former tracker's twelve- and
  thirteen-digit numbers, read as not found.

## Numbers

The tracker asks for an AWB number. Customers and archived lookups show bare digit runs: twelve
and thirteen digits on the former tracker, and fourteen digits on recent dockets, which begin
with the two digits of the booking year. Digit runs of these lengths are printed by many other
carriers, so no rule claims them and a number filed under Shree Maruti reaches the adapter. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The home page's tracking box opens `shreemaruti.com/track-shipment/?awb={number}`, which loads
the tracker at `tracking.shreemaruti.com/{number}` in a frame. The tracker also reads the
number from its `d` and `shipmentNo` parameters, as archived lookups on
`shreemaruti.com/tracking/` and `clients.shreemaruti.com/tracking/` show. The former tracker
took it as `tracking_id` on `shreemaruticourier.com/track-your-shipment/` and later on
`shreemaruti.com`.

## Testing

`npm run test:carriers:live -- carriers/shree-maruti`, with `SHREE_MARUTI_TRACKING_NUMBER` and
optionally `SHREE_MARUTI_UNKNOWN_NUMBER` set outside the repository.
