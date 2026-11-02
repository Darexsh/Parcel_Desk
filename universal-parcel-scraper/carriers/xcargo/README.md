# X-Cargo

X-Cargo parcels use enabled universal providers. There is no dedicated adapter.

X-Cargo is a Bogotá express courier with an electric last-mile fleet, delivering across Colombia, SHEIN's
parcels among others. Its site is x-cargo.co.

## Numbers

Its numbers are sixteen digits in the one public example, a regulator's reply, and no check digit fits them.
Sixteen digits are shared by other carriers, so there is no rule.

## Why there is no adapter

Its home page embeds Big Smart's tracking widget, the platform Big Smart's own entry runs on. The widget
reads an open JSON API without a CAPTCHA: `GET api.bigsmart.mx/api/order-logs/{number}?populate=true&language=es`
with a bearer token the public widget script gives every visitor, and x-cargo.co as origin. It answers the
public example with its scans and an unknown number with a 404. The token expires yearly, so an adapter would
read it from the widget script. Its scans carry Mexico's GMT-06:00 offset, which an adapter has to check
against Colombian time, and its delivery notes name the receiver. No adapter has been written for it yet.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
