# Multientrega

Multientrega parcels use enabled universal providers. There is no dedicated adapter.

Multientrega (MULTIENTREGA SA) is a Panamanian courier and logistics company. It distributes parcels
and documents across the country from hubs in Panama City, the central provinces and Chiriquí, and
stores and ships online orders for shops. Its site is multientregapanama.com.

## Numbers

Its tracker takes a numeric guide number and gives no layout or example. No public number is known,
so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service without a login or CAPTCHA, which answers an unknown
number as not found. Its reply also carries the recipient's address and phone numbers, which an
adapter would leave out. No public number has shown a known parcel's reply yet. An adapter can
follow.

## Links

Tracking links carry the number in the path after `/session/order/` on
servicios.multientregapanama.com. Links under `/session/order/client/` look up a merchant's own
reference and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
