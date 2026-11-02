# Bringer Parcel Xpress

Bringer Parcel Xpress (BPX, formerly Bringer Parcel Services) is the e-commerce parcel service
of the Bringer group in Miami. It ships from the United States to Latin America and hands
Brazilian parcels to Correios. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://bps.bringer.io/parcels/track-public/{number}`, as the tracking
   page on bringerparcel.com asks for each number typed in. It needs no cookie, token, key or
   browser. The JSON reply lists the parcels the number names, each with its scans, newest
   first.
2. `retry`: the same request once more after a request that failed to reach BPX or ran out of
   time. The first gets half of the budget.

- An unknown number is HTTP 404 with `Parcel with tracking code {number} not found`, which is
  not found only when it names the number asked. Another 404, a 410 or a redirect is a moved
  route. An empty list, which the page reports as no match, is not found too.
- The tracker matches the whole number and its case; the adapter asks in capitals.
- The tracker also finds a parcel by another carrier's number it carries, so a parcel counts
  only when its own `trackingCode` is the number asked.
- A firewall or bot check's page in place of the reply, even with HTTP 200, is a challenge.
- Recognition makes the same request.

## Notes

- Each scan's `createdAt` is an instant in UTC, which the page shows in the reader's zone, so
  the scans keep it as their time.
- Every scan carries a parcel status, such as `received_for_shipping` or `customs`, and some a
  BPX event code and wording, such as `BPS-0001` `Label Created`. The page shows the wording,
  else the status's label. The provider code is the BPX code, else the status. The status
  stages the scan, except for the codes BPX closes a parcel with (delivered on its evidence,
  returned, lost, stolen, abandoned, refused, disposed of), which the code stages. An error
  creating the label moves nothing.
- The parcel's own status decides a delivery, a return or an undeliverable parcel. Otherwise
  it can lag the scans, as `pending` beside a label scan, and the newest staged scan decides.
- A scan's place is dropped when it holds a digit, which could be an address or a postal code.
- The reply's external number can be the parcel's first-mile or last-mile number of another
  carrier, without naming that carrier, so the adapter keeps no hand-off.
- The API documentation's legacy route, `GET
  https://bps.bringer.io/public/api/v2/get/parcel/tracking.json?tracking_number={number}`,
  also answers without a token, with the scanning site's postal code beside each scan. The
  adapter uses the page's route.

## Limitations

- No estimate, weight, service, destination, sender or recipient.

## Numbers

BPX's API documentation calls its own number the BPS tracking number and gives examples of
`BPS` and twelve or thirteen letters and digits, which is what the adapter takes.
`bringer-parcel-1` claims that layout with low confidence, and recognition asks the tracker.
Parcels also carry first-mile and external numbers of other carriers, which stay with those
carriers. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form opens one parcel at `bringerparcel.com/tracking/{number}`. The library reads
the number from that address.

## Testing

`npm run test:carriers:live -- carriers/bringer-parcel`, with `BRINGER_PARCEL_TRACKING_NUMBER`
and optionally `BRINGER_PARCEL_UNKNOWN_NUMBER` set outside the repository.
