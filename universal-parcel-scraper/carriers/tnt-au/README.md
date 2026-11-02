# TNT Australia

TNT Australia, part of FedEx Express Australia, carries domestic express consignments across
Australia. Its consignment notes print three letters and nine digits. The adapter reads TNT
Australia's own public tracker; tnt.com's tracking API refuses these numbers and sends the lookup
there.

## How it works

1. `direct`: `GET www.tntexpress.com.au/interaction/ASPs/trackref_detail.asp?con={number}`, the
   page TNT Australia's older tracking form opened, without a session or CAPTCHA. It repeats the
   consignment asked, which must be the one asked, then lists its scans oldest first, each with a
   wording, a day, a time and the depot, and gives the estimated delivery above them. A number it
   does not know has one row, "No consignment was found", which is read as not found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs. The first
   attempt gets half of the budget.

Recognition asks the same page.

## Notes

- The current form, `Trackntrace.aspx`, posts the number and redirects to a result page whose
  address encrypts it, and its not-found page does not repeat the number, so the adapter reads the
  older page instead.
- Scans are on the depot's wall clock without an offset. Depots span Australia's time zones, so each
  scan keeps its depot as its location and is dated on that place's clock.
- The scans carry no code; their wordings are mapped in [statuses.json](statuses.json), and another
  wording falls to the shared wording rules. A delivery booked in by the recipient adds
  "Book-In Delivery Requested" and "Book-In Delivery Arranged", the latter also after the delivery;
  they keep the stage the parcel had.
- The estimated delivery is kept as a day until the consignment is delivered.

## Numbers

Three letters and nine digits are also Purolator's lettered PINs, and Colis Privé takes any twelve
letters and digits, so the rule is low confidence and recognition asks each of them. tnt.com's
answers for archived numbers name these as TNT Australia domestic consignments.

## Limitations

- Reference and same-day job numbers, which the form also takes, are not read.
- The milestone view and proof of delivery are not read.

## Testing

Set `TNT_AU_TRACKING_NUMBER` and `TNT_AU_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/tnt-au`.
