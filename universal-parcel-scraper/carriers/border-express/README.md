# Border Express

Border Express is an Australian freight and parcel carrier with depots in every mainland state.
Tracked through the lookup BEX Online's Quick Track makes.

## How it works

1. `direct`: `GET https://bexonlineapi.borderexpress.com.au/v1/consignments/quicktrackverification`
   returns a verification id and sets a short-lived `qt-verification` cookie. Then
   `GET https://bexonlineapi.borderexpress.com.au/v2/consignments/quickTrackpublic?consignmentNumber={consignment}`
   carries the id as `x-qt-verification` and the cookie, as Quick Track sends them. It needs no
   session, captcha, key or browser. The JSON reply lists the consignment's current status, its
   estimate and delivery, and its status rows.
2. `retry`: one more try with a new verification when a request fails to reach Border Express or
   hangs. The first try gets half of the budget.

- Both requests name the application with `bex-application-name: bexonline`, as Quick Track
  does. Without it the service's gateway answers a bare 403.
- An unknown consignment is HTTP 404 with an ASP.NET problem reply titled `Not Found`, which
  Quick Track's script reads as not found. A 404 without that reply, or a redirect, is a moved
  route.
- The reply must hold exactly one consignment whose `consignmentNumber` is the number asked.

## Notes

- Each row's `dateOccurred` carries the offset of the depot's state, and the adapter keeps it.
  Queensland stays on standard time while the southern states are on daylight time.
- The tracker hides the sender's own booking states, such as Unsaved before Shipment Data
  Received, and so does the adapter. The Picked Up step often has no date, so it is skipped.
- The summary's `integrationCode` decides the stage. Partially Delivered (`PAR`) is in transit,
  because some units are delivered and the rest are still on their way. Partially Delivered -
  Final (`FIN`) closes the consignment with the units that arrived, and Quick Track shows it as
  delivered, as the adapter does. A code the map does not know falls to the shared wording rules.
- The estimate is a calendar day. The delivery time is `deliveredDate`, with its offset.
- Quick Track does not take a unit's barcode. The adapter reads one back into its consignment by
  the label specification's formula: the prefix, then the range without its zero padding, six
  digits long when shorter. When the reply lists Border Express labels for its units, one of them
  must share the barcode's stem. A 404 for that reading is inconclusive, because the range could
  have another length. The consignment becomes the canonical number.
- The localities, postcodes, unit counts, unit labels and their scans, the despatch day and the
  signatory are not kept.
- There is no recognition. The consignment shapes are shared with other carriers, and no rule
  claims them. The unit barcode is Border Express's own, but the tracker only answers the
  consignment read from it, and a 404 there does not show the barcode unknown.

## Limitations

- No weight, service, sender, recipient or proof of delivery.
- A range longer than six digits that starts with zeros cannot be read from a barcode.

## Numbers

Border Express consignments carry either a plain eight-digit number or a four-letter sender
prefix followed by a range, documented as six digits; the tracker also answers longer ranges,
and the adapter takes five to eight digits. Both shapes are shared with other carriers, so no
rule claims them. Each label unit carries a barcode made of the prefix, `BX`, the range
zero-padded to eleven digits and a three-digit unit number; `border-express-1` takes that
barcode with low confidence. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The online tracker at `bexonline.borderexpress.com.au/bxo/track` takes the number as
`consignmentNumber`; a unit barcode's link gives it the consignment read from the barcode. The
website's older tracker, `borderexpress.com.au/tracking/?cn=`, no longer
answers.

## Testing

`npm run test:carriers:live -- carriers/border-express`, with `BORDER_EXPRESS_TRACKING_NUMBER` and
optionally `BORDER_EXPRESS_UNKNOWN_NUMBER` set outside the repository. A tracking number with a
sender prefix also checks the barcode reading.
