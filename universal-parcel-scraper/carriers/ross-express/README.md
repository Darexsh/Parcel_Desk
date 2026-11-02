# Ross Express

Ross Express parcels use enabled universal providers. There is no dedicated adapter.

Ross Express is a New England less-than-truckload carrier based in New Hampshire, majority owned
by [PITT OHIO](../pitt-ohio/README.md) and run under its own name. Its site is rossexpress.com.

## Numbers

Its PRO numbers are seven digits, a length many carriers share, and no public one has been
found, so there is no rule.

## Why there is no adapter

Its tracker is hosted by Carrier Logistics, whose open XML trace
[Dohrn Transfer](../dohrn-transfer/README.md)'s adapter reads, but no public PRO number has been
found to check a found reply with. Seven-digit numbers are densely used, so a made-up one often
finds someone else's bill or quote.

## Links

The tracker's shipment page opens a PRO number from its `wpro1` parameter, and its entry page
from `pronum`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
