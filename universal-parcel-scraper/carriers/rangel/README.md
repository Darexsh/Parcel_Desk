# Rangel

Rangel parcels use enabled universal providers. There is no dedicated adapter.

Rangel Logistics Solutions, founded in Portugal in 1980 as a customs broker, handles customs,
contract logistics, online-shop fulfilment and air, sea and road freight, with offices of its own in
Portugal, Africa, Brazil and Mexico. Its site is rangel.com.

## Numbers

Its tracker takes Rangel's own transport guide numbers or a reference, and gives no layout or
example. Rangel's express parcels travel with Correos Express Portugal, born of its alliance with
Correos Express in Spain, under [Correos Express](../correos-express/README.md) numbers. As FedEx's
partner in Portugal it hands FedEx numbers to [FedEx](../fedex/README.md)'s tracker. No public
Rangel number is known, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a login or CAPTCHA, which answers an unknown number
with an empty shipment rather than an error. No public number has shown a known shipment's reply
yet. An adapter can follow.

## Links

Tracking links carry the number in the path after `/track/search/` on my.rangel.com; for a FedEx
number the page opens FedEx's tracker. Links in its notifications carry a hashed code instead and
are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
