# Castle Parcels

Castle Parcels is a Freightways courier brand in New Zealand whose website forwards to Post
Haste's. Tracked through the Freightways lookup under Castle Parcels' name, with the group's
tracker and parser ([freightways.ts](../nz-couriers/freightways.ts)).

## How it works

1. `direct`: one `GET https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/CastleParcels/tracking-events`,
   the name Castle Parcels' receiver site, `receiver.castleparcels.co.nz`, gives the lookup. A
   courier ticket goes as `?searchType=TK&ticketProductCode={code}&query={number}`, a charge
   label, SSCC or customer printed label's consignment number as `?query={number}`, as for New
   Zealand Couriers ([README](../nz-couriers/README.md)).

- An unknown number is an empty HTTP 204.
- A customer printed label's consignment number is found only under the network that issued
  it, so a Castle Parcels label asked under Post Haste's name reads as not found.
- Recognition is off. The lookup answers for every Freightways network, and the group's
  networks print the same layouts, so a known answer would not show that a number is Castle
  Parcels'.

## Notes

- Each scan names the Freightways network that made it, often Post Haste for Castle Parcels'
  parcels. When the newest is another catalog carrier's, that carrier becomes the delivery
  carrier.
- Scan times are UTC instants, kept as they are. Scan types share New Zealand Couriers' status
  map.
- Signatures with the signatory's name, delivery photos, the authority-to-leave tag, the
  barcode, postcodes, branches, drivers and runs are not kept.

## Limitations

- castleparcels.co.nz sends every page, its tracking page too, to posthaste.co.nz. Only the
  receiver site and the older servlet keep Castle Parcels' name.
- A customer printed label is read only by its consignment number, in the layouts New Zealand
  Couriers' adapter reads ([README](../nz-couriers/README.md)). A label the lookup finds only
  with the sender's account needs the tracking link that names it, as for New Zealand Couriers.
  Contract bags and manifest references are not read.
- A consignment the tracker no longer holds reads as not found.
- No weight or service.

## Numbers

A courier ticket carries a product code of up to four characters and an eight-digit ticket
number. Today's tickets use Post Haste's codes of two or three letters; older area guides also
list codes with digits, such as N3, N10, NI25 and N10W, whose number the adapter needs in full.
Charge labels carry eight digits. Customer printed labels pair the sender's account number with
a consignment number, so they are not kept. The track and trace page and the area guides give
the samples, and an archived lookup on the tracker gives a ticket. Post Haste and New Zealand
Couriers print tickets in the same layout, and eight digits are shared by many carriers, so no
rule claims either.

## Links

The receiver site and the older servlet at `/cpl/servlet/ITNG_TAndTServlet` are read as for New
Zealand Couriers ([README](../nz-couriers/README.md)).

## Testing

`npm run test:carriers:live -- carriers/castle-parcels`, with `CASTLE_PARCELS_TRACKING_NUMBER`
and optionally `CASTLE_PARCELS_UNKNOWN_NUMBER` set outside the repository.
