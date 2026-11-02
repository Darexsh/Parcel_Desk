# Daylight Transport

Daylight Transport is a less-than-truckload freight carrier in the US. Tracked through the
lookups its shipment page makes.

## How it works

1. `direct`: two `GET`s at once, as the shipment page at
   `mydaylight.dylt.com/external/shipment?probill={probill}` makes them:
   `https://mydaylight.dylt.com/api/v1/shipments/public?probill={probill}` for the shipment's
   details and `https://mydaylight.dylt.com/api/v1/shipments/history/public?probill={probill}`
   for its history, newest row first. They need no cookie, token, key or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A probill the tracker does not know is HTTP 404 with an empty search in the details and an
  empty history. A history under such a probill is inconclusive. Any other 404, a 410 or a
  redirect is a moved route.
- The details must name the probill asked; a reply for another shipment is inconclusive and
  nothing from it is kept.
- The adapter asks by whole probill only; the page's searches by bill of lading and purchase
  order numbers are not used.
- Recognition makes the same requests.

## Notes

- No clock names its zone, so clocks stay wall clocks in `local_time` and the delivery has no
  instant.
- The history writes its wording in capitals; the result writes each word capitalized, as the
  page does.
- A row's place is a customer's ZIP code, town and state, or a terminal's code with its town. The
  result keeps the town and state, or the terminal's town.
- A shipment the details call delivered without a delivery row gets one, at the details'
  delivery time.
- Until the delivery, the estimate is the day of the delivery window the details give.
- Appointment rows, needed or made, can come before the pickup and have no stage.
- The details hold the shipper, the consignee and the forwarder with their addresses, contacts,
  phones and e-mails, references, items, weights, special instructions and notification e-mails;
  none of them is read.

## Limitations

- No sender, recipient, signature or delivery receipt.
- A probill reaches the adapter when it is filed under Daylight Transport or opened from a
  Daylight link: eight digits are shared by many carriers, so no rule claims them and preflight
  does not ask it.
- Daylight reuses probills, so an old one opens the newest shipment under it.

## Numbers

Daylight tracks freight by its probill (PRO) number. Lookups archived from its former tracing
pages and its current tracker show eight-digit probills with no check digit. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The home page's Track PRO form opens one shipment at `mydaylight.dylt.com/external/shipment`
with the number in `probill`, and the former tracing result page took it in `SelectionValue`.
The library reads the number from both. Reused probills keep the link out of the daily rendered
link check.

## Testing

`npm run test:carriers:live -- carriers/daylight-transport`, with
`DAYLIGHT_TRANSPORT_TRACKING_NUMBER` and optionally `DAYLIGHT_TRANSPORT_UNKNOWN_NUMBER` set
outside the repository.
