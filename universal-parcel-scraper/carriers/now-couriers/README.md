# Now Couriers

Now Couriers is a Freightways courier in New Zealand. Tracked through the Freightways lookup
under Now Couriers' name, with the group's tracker and parser
([freightways.ts](../nz-couriers/freightways.ts)).

## How it works

1. `direct`: one `GET https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/NowCouriers/tracking-events`,
   as Now Couriers' receiver site, `receiver.nowcouriers.co.nz`, asks it. A courier ticket goes
   as `?searchType=TK&ticketProductCode={code}&query={number}`, a charge label, SSCC or customer
   printed label's consignment number as `?query={number}`, as for New Zealand Couriers
   ([README](../nz-couriers/README.md)).

- An unknown number is an empty HTTP 204, which the receiver site reports as no match.
- A customer printed label's consignment number is found only under the network that issued
  it, so a Now Couriers label asked under another network's name reads as not found.
- Recognition is off. The lookup answers for every Freightways network, and the group's
  networks print the same layouts, so a known answer would not show that a number is Now
  Couriers'.

## Notes

- Each scan names the Freightways network that made it. When the newest is another catalog
  carrier's, such as Post Haste, that carrier becomes the delivery carrier.
- Scan times are UTC instants, kept as they are. Scan types share New Zealand Couriers' status
  map.
- Signatures with the signatory's name, delivery photos, the authority-to-leave tag, the
  barcode, postcodes, branches, drivers and runs are not kept.

## Limitations

- A customer printed label is read only by its consignment number, in the layouts New Zealand
  Couriers' adapter reads ([README](../nz-couriers/README.md)). A label the lookup finds only
  with the sender's account needs the tracking link that names it, as for New Zealand Couriers.
  Contract bags and manifest references are not read.
- A consignment the tracker no longer holds reads as not found.
- No weight or service.

## Numbers

A prepaid ticket carries a product code of two letters, or three for an add-on such as SAT or
RES, and an eight-digit ticket number. Charge labels carry eight digits. Customer printed labels
pair the sender's account number with a consignment number, so they are not kept. The prepaid
tickets reference guide and an archived tracking page give the samples. The other Freightways
networks print tickets in the same layout, so no rule claims them.

## Links

nowcouriers.co.nz sends its Track link to the receiver site. The receiver site and the older
servlet at `/now/servlet/ITNG_TAndTServlet` are read as for New Zealand Couriers
([README](../nz-couriers/README.md)).

## Testing

`npm run test:carriers:live -- carriers/now-couriers`, with `NOW_COURIERS_TRACKING_NUMBER` and
optionally `NOW_COURIERS_UNKNOWN_NUMBER` set outside the repository.
