# STG LTL

STG LTL parcels use enabled universal providers. There is no dedicated adapter.

STG LTL is STG Logistics' less-than-truckload carrier, formerly Frontline Freight, carrying freight
to and from Southern California. Its tracker still carries the Frontline Freight name, so that
name counts as STG LTL's. Its site is stgltl.com.

## Numbers

No public page shows one of its PRO numbers, so there is no rule.

## Why there is no adapter

Its tracker is hosted by Carrier Logistics, whose open XML trace
[Dohrn Transfer](../dohrn-transfer/README.md)'s adapter reads, but no public PRO number has been
found to check a found reply with.

## Links

The tracker's shipment page opens a PRO number from its `wpro1` parameter, and its entry page
from `pronum`. The site also links a Frontline Freight tracking domain, whose pages are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
