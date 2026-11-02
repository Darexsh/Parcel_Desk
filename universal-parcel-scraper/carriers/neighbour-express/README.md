# Neighbour Express

Neighbour Express parcels use enabled universal providers. There is no dedicated adapter.

Neighbour Express is a Canadian last-mile courier with its own drop-off stores. Shoppers
returning AliExpress and SHEIN orders print its return labels and drop the parcels at one of
those stores.

## Numbers

Its return label numbers start with NR; the AliExpress return page shows them masked, ending
in AE. The tracker sends numbers that start with N and have R as their sixth character to one
lookup and every other number to a second lookup that also takes the recipient's postal code.
No public source shows a whole number, so the corpus is empty and no rule claims a shape.

## Links

`neighbourexpress.com/track` and `neighbourexpress.ca/track` with `trackingNumber` or `no`
open one parcel. Numbers on the second lookup also need the postal code, which no link
carries.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
