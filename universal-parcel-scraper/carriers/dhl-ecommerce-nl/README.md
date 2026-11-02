# DHL eCommerce Netherlands

DHL's parcel network in the Netherlands and Belgium, formerly DHL Parcel
Benelux, through the gateway behind its tracking page. German DHL Paket is
[dhl](../dhl/README.md) and the Americas network is
[dhl-ecommerce](../dhl-ecommerce/README.md).

## How it works

1. `direct`: `GET api-gw.dhlparcel.nl/track-trace?key=…`, the request
   `my.dhlecommerce.nl` makes for a parcel opened without a postcode. It returns
   one shipment with an oldest-first event feed. An unknown key is a 404 with a
   fixed sentence, which is the only answer read as a missing parcel.

## Notes

- The key is sent without a postcode. The gateway then leaves out the
  recipient, the address, the signature and the ServicePoint, so there is
  nothing personal to discard and no place on a scan.
- Events carry a status code and a category, no text. The wording is the
  English translation the tracking page loads, kept in
  [statuses.json](statuses.json) with the stage of each code. It is stored
  rather than fetched so a scan reads the same on every lookup.
- A code missing from that list takes the stage of its category. The page
  files clearance and courier scans in categories that also hold sorting scans
  and next-day plans, so those two categories only mean movement.
- The parcel app's review (`statusMap`) reads the code, or a copy's wording
  through that list. A code missing from the list stays open there, since the
  stored scan does not keep its category.
- A delivery or a return to the sender stays the current stage when a notice
  follows it.
- A ServicePoint notice that failed to reach the recipient still means the
  parcel waits there, as the notice that was sent does. "Handed over to the
  courier" is the depot's hand-over for the delivery round, just before it
  goes out, so it reads as out for delivery.
- A scan can carry a planned window or a single expected moment, both with
  offsets. The newest one is the estimate; a scan with both counts as its
  window, as on the tracking page. A delivery, a parcel waiting at a
  ServicePoint or a later scan clears it.
- The feed repeats a scan it received from two systems; one is kept. A gateway records one
  departure several times within minutes, on two networks; the shared reading keeps the first.
- The gateway also follows parcels of DHL's European road network that enter
  the Benelux, including German `JJD` numbers. Detection leaves those with DHL
  Paket; the adapter accepts them when the carrier is named.
- It also answers a shipper's SSCC (`00` and eighteen digits with a valid GS1
  check digit), seen on public tracking pages. A valid SSCC names no carrier,
  so detection never offers DHL eCommerce Netherlands for one; the adapter
  accepts it when the carrier is named. DHL Paket's own SSCCs, the ones
  detection selects DHL Paket for, stay with DHL Paket.
- PostNL prints `3S` barcodes too, nearly all with a four-letter customer code.
  DHL's usually carry three letters: three letters and eight to ten digits
  select DHL, and other two- and three-letter codes only suggest it. For
  two-letter codes, which PostNL also uses, recognition asks DHL alone, as
  PostNL's tracker cannot confirm them.

## Limitations

- Scans have no location.
- A DHL `3S` barcode with a four-letter customer code is detected as PostNL;
  the adapter reads it when the carrier is named. A few PostNL barcodes have
  three letters and are detected as DHL.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-nl` checks that a
synthetic number gets a clean not-found. Set
`DHL_ECOMMERCE_NL_TRACKING_NUMBER` outside the repository to read a real parcel.
