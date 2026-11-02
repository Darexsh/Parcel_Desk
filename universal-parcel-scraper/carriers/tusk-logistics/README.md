# Tusk Logistics

Tusk Logistics, of Chicago, sells US e-commerce brands parcel delivery through a network of
regional carriers under its own labels. Its parcels use enabled universal providers; 17TRACK
lists the carrier. There is no dedicated adapter.

## Numbers

Tusk's help desk says its tracking numbers are `TUSK` and twelve letters or digits. No other
carrier's rule takes the prefix, so `tusk-logistics-1` has high confidence. Links to Tusk's
tracking page carry the number in `trackingNumber`.

## Leads

Tusk's tracking page, `https://shipmenttracking.tusklogistics.com/?trackingNumber={number}`,
renders its answer over a Blazor Server websocket, without a postcode, login or CAPTCHA. It
names the regional carrier that delivers and that carrier's own number, a hand-off an adapter
could follow.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
