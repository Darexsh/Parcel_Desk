# Miller Deliveries

Miller Deliveries parcels use enabled universal providers. There is no dedicated adapter.

Miller Deliveries (מילר משלוחים) is an Israeli courier that delivers across the country from
branches in Beersheba, Lod, Sderot and Acre. Its site is millerdeliveries.co.il.

## Numbers

Its status page gives no layout or example, and no public page shows a shipment number, so there is
no rule.

## Why there is no adapter

The status page reads the number from its address without a session or CAPTCHA, but for an unknown
number it stops after the heading, which does not tell a missing shipment from a failure. No public
number has shown a known shipment's reply yet.

## Links

Tracking links carry the number as `shipment_id` on the status page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
