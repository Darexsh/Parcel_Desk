# Tusass

Tusass parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Tusass, formerly TELE-POST and POST Greenland, follows postal items under UPU S10 numbers.
Its former help named parcels posted in Greenland and parcels from Denmark under Post
Danmark's numbers as typical barcodes, and lookups archived from its former tracker carry
both. Generic postal detection handles S10 numbers, so no Tusass rule claims them. The
tracker also follows DHL Express pieces by their DHL piece id, and the former one followed
DHL and FedEx airwaybills within Greenland and to and from Denmark; those numbers stay with
DHL and FedEx.

## Links

The tracker reads the number from the fragment of its page address and writes it back there
after a search, so `tusass.gl/en/track-and-trace/#{number}` opens one parcel; the Greenlandic
and Danish pages work the same way. The page posts a GraphQL `tracking` query with the barcode
and language to `/api/track-trace`; an unknown or expired number answers an empty log. No found
reply has been seen, so there is no adapter yet.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
