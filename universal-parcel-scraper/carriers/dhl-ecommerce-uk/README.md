# DHL eCommerce UK

DHL's domestic parcel network in the United Kingdom, formerly DHL Parcel UK
and UK Mail, through its tracking page. German DHL Paket is
[dhl](../dhl/README.md) and the Benelux network is
[dhl-ecommerce-nl](../dhl-ecommerce-nl/README.md).

## How it works

1. `direct`: `GET track.dhlecommerce.co.uk/?con=…`. The page renders the
   journey on the server: one row per scan with a date, a clock and a sentence,
   newest first. An unknown number gets the same page with a notice in place of
   the journey.

## Notes

- No postcode is sent. A wrong postcode hides a shipment that exists, and the
  page would then read as a missing parcel.
- Only the notice that names an unmatched shipment number is read as a missing
  parcel. The page also comes back empty when it did not look the number up,
  and that is an inconclusive answer.
- The headline and most rows name the shipment. The parser requires the
  headline to name the number asked for, rejects a row that names another
  one, and keeps the sentences without it.
- The page has no status codes. [statuses.json](statuses.json) lists the
  sentences seen with the stage each one means; a sentence missing from it
  keeps its wording and gets no stage.
- A depot scan can follow a delivery scan. The page then shows the shipment at
  the depot again, so the newest row sets the current stage. A refused
  shipment also returns to the depot, and only the headline says it is going
  back to the sender, so that headline makes it returned.
- The network runs in one time zone, so the clocks are read as British time.
- The signatory's name and the sender's reference are shown without a postcode
  and are dropped.

## Limitations

- Scans have no location.
- Fourteen digits is also the shape of DPD, BRT and other numbers, so detection
  offers this carrier as one candidate and the page's answer attributes the
  shipment. It suggests this carrier first for numbers starting with 6012, the
  range its tracking page shows most. Recognition asks it only about the ranges its
  page and DHL's examples show, starting 31, 41, 55 or 60.
- The page drops a shipment some time after delivery and then answers as for an
  unknown number.
- Calling cards and customer references need the delivery postcode and are not
  supported. Nine-digit return numbers are accepted when the carrier is named
  and claimed by no detection rule.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-uk` checks that a
synthetic number gets a clean not-found. Set
`DHL_ECOMMERCE_UK_TRACKING_NUMBER` outside the repository to read a real
shipment.
