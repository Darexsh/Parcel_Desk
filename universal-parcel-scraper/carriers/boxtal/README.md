# Boxtal

Boxtal is a French shipping platform: online shops and individuals book parcels through it with
Mondial Relay, Chronopost, Colissimo, Relais Colis, UPS and other carriers, which collect and
deliver them under their own numbers. Its booking reference is tracked through its tracking page.

## How it works

1. `direct`: one `GET https://private-gateway.boxtal.com/v2.1/carrier/tracking/{reference}`, the
   lookup the tracking page makes. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A reference the tracker does not know gets HTTP 404 with a message naming it, read as not
  found. Any other 404, a redirect or a 410 is a moved route, and a firewall page or a 403 is a
  challenge.
- Each parcel of the booking echoes the reference; a reply for another one leaves the answer open.
- Recognition makes the same request.

## Notes

- Boxtal relays the collecting carrier's scans: its text, detail and place, a wall clock with no
  offset, and a state letter of Boxtal's own. The letter decides the stage, by the label the page
  shows for it, and is kept as the provider code; letter Z, "Other", leaves the stage to the
  shared wording rules on the carrier's text.
- Scan clocks stay `local_time`, on French time for the French carriers Boxtal books.
- For a booking of one parcel, the carrier its tracking link points to becomes the delivery
  carrier, with the number beside the link when the link names it. The link carries the shipper's
  account, so it is not kept, nor is the shipper's order reference.

## Limitations

- No instants, expected delivery or proof of delivery.
- A booking of several parcels names no delivery carrier.
- Boxtal only has the scans the carrier sends it, often fewer than the carrier's own tracker.

## Numbers

A Boxtal reference is ten digits that start with the booking's date, the carrier's four-letter
code, four letters or digits and FR. Detection takes those with a valid date.

## Links

A link to the tracking page with the reference in its `reference` parameter opens one booking.

## Testing

`npm run test:carriers:live -- carriers/boxtal`, with `BOXTAL_TRACKING_NUMBER` and optionally
`BOXTAL_UNKNOWN_NUMBER` set outside the repository.
