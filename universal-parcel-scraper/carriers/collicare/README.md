# ColliCare

ColliCare parcels use enabled universal providers. There is no dedicated adapter.

ColliCare Logistics is a Norwegian road freight and parcel carrier with a network across Norway,
Sweden, Denmark and Finland. Its site is collicare.no.

## Numbers

It numbers shipments with seventeen-digit GS1 shipment numbers and packages with SSCCs, layouts
many carriers share, so there is no rule.

## Why there is no adapter

Its tracker reads an open JSON search with a key every visitor gets, but no current public
number has been found to check a found reply with.

## Links

The tracker opens a number from its `s` parameter, or from `#/s/{number}` in its address, the
form it moves to.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
