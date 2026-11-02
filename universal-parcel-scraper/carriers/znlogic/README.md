# Zinc

Zinc parcels use enabled universal providers. There is no dedicated adapter.

Zinc Technologies, the San Francisco maker of the PriceYak and JoeLister drop-shipping tools, gives
orders that a retailer ships its own tracking number, which marketplaces such as eBay show under the
carrier name ZNLOGIC. Its tracker is at tracking.link.

## Numbers

Its numbers are ZPY, two letters, ten digits and YQ. Detection suggests Zinc for that shape at low
confidence, as its known numbers come from one source.

## Why there is no adapter

The tracker asks an open JSON service with the number alone and relays the delivering carrier's
scans without that carrier's number. Its reply also carries the recipient's ZIP code, which an
adapter would have to drop. An adapter can follow.

## Links

Tracking links carry the number as `tracking_id` on the `tracking` page at tracking.link.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
