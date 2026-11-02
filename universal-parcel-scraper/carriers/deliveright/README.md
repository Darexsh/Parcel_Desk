# Deliveright

Deliveright parcels use enabled universal providers. There is no dedicated adapter.

Deliveright Logistics, Inc., in Lexington, North Carolina, delivers furniture and other large items
to homes in the United States with white-glove service for retailers, booked on its own platform,
Grasshopper. Its site is deliveright.com.

## Numbers

Its tracker takes a tracking id alone, or an order or purchase order number with the customer's last
name. Its older order ids were eleven digits, a shape that many carriers' rules read, Old Dominion's
among them. No public id has shown its tracker's answer, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service with the tracking id alone, without a login or CAPTCHA, and
answers an unknown id as not found. No public id has shown a known delivery's reply yet. An adapter
can follow.

## Links

Tracking links carry the tracking id in the path after `/gh-lite/tracking/` on app.deliveright.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
