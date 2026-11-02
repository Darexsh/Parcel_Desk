# HR Parcel

HR Parcel is an Italian parcel service of the Sailpost group that delivers e-commerce
parcels, many from Chinese and German senders. Tracked through the lookup its tracking page
makes.

## How it works

1. `direct`: one `GET https://www.hrparcel.com/wp-admin/admin-ajax.php` with
   `action=api-hrparcel-tracking&api-method=get&api-action=barcode&q={number}`, the WordPress
   action the tracking page's script calls for a barcode. It needs no cookie, token, key or
   browser. The JSON reply, served as HTML, holds `shipment` and `steps`, which the page
   shows, and `response`, the shipment service's own record.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with a `shipment` whose `id` is null, which the page reports
  as not found. A service error comes as `response.InternalError` and is inconclusive. A 404
  or a redirect is a moved route.
- The number asked must be one of the shipment's barcodes in `response.BarcodeList`, which
  lists every parcel of the shipment.
- A shipment the sender booked can come without scans; it has no history to show.
- Recognition makes the same request.

## Notes

- Each scan's `originalDate` is the branch's wall clock to the second, with no zone, so the
  clocks stay `local_time`.
- The scan's `code` stages it. `1007`, a parcel held at the branch (giacenza) for the
  recipient's instructions, is an exception, unless its label says the branch also offers it
  for collection.
- The page leaves out the town of the first two scans, the sender's data and the hub's
  intake, and so does the adapter. A town that gives its province twice keeps it once.
- The service's record also carries the order reference, an item description, a weight and
  the name of whoever signed for the parcel, none of which the page shows. None of it is
  kept, nor the departure hub, the parcel count, the progress bar or the hold instructions
  the page shows.

## Limitations

- No delivery estimate, and no clock as an instant.
- The page can also search by the sender's reference (`api-action=reference`), which can be
  another carrier's number, such as a YunExpress one. The adapter searches barcodes only.

## Numbers

HR Parcel's own barcodes are fourteen digits, as archived lookups on its tracker and reviews
it answered show, sometimes with the sender's number as the reference. Fourteen digits are
shared by many carriers, so no rule claims them.

The tracker also files some senders' parcels under the sender's own label number: iHerb's
`IHB` numbers, Hermes Germany's numbers for parcels Hermes hands over in Italy, and the
twenty-digit SSCCs of senders such as Mango. The adapter tracks them when HR Parcel is the
chosen carrier, but no HR Parcel rule claims them: they stay with the carriers that issue
them. YunExpress numbers are only references.

## Links

HR Parcel's tracker fills its barcode search from `?barcode=` and searches when the page
opens, so `hrparcel.com/traccia-spedizioni/?barcode={number}` opens one parcel. Archived
lookups also use the English page `hrparcel.com/en/tracking/?barcode={number}`. The library
reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/hr-parcel`, with `HR_PARCEL_TRACKING_NUMBER` and
optionally `HR_PARCEL_UNKNOWN_NUMBER` set outside the repository.
