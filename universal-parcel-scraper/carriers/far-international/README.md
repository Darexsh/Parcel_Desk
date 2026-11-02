# FAR International

FAR International is 泛远国际, a Hangzhou cross-border forwarder whose site is far800.com, with
end-to-end lines to the Americas and Europe. Universal providers name it FAR International. The
adapter reads FAR's own results page for its waybills.

## How it works

1. `direct`: the tracker's results page is `GET https://www.far800.com/logistics/result?key=<number>`,
   server-rendered HTML without a cookie, key or CAPTCHA, and the adapter sends the same request.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

## Notes

- Only the entry whose number is the whole number asked is read.
- A scan with an offset in its zone column gets an instant at that offset, and the scans are then
  ordered by instant. Older parcels have an empty zone column: those scans keep their wall clock
  and the page's order, and consumers can date them by place.
- Older scans pair Chinese wording with its English translation, of which the English is kept.
  Newer scans are English or Chinese, with the last-mile carrier's own wording near the end. They
  are staged by the wording recorded in [statuses.json](statuses.json), then the shared rules.
- The status above the scans is not read: it can still read 在途 (in transit) under a delivery.
  The delivery date beside it is not read either; `delivered_at` is the delivery scan's instant.
- The last-mile label is often listed after the parcel reached the departure hub, so it is no
  step back.
- The last-mile number becomes `delivery_tracking_number` when it is not FAR's own.
- A number the tracker has nothing for shows an empty list, which is no history rather than a
  missing parcel. Redirects, 404s and browser checks are never read as a missing parcel.

## Numbers

Its waybills are FAR, two letters, ten digits and YQ, the layout of forwarders on the Hualei
(华磊) platform, who open their waybills with their own code, as [GZYL](../gzyl/README.md) does.
FAR's own tracker answers such a number with its history, and
[Ship24's FAR International page](https://www.ship24.com/couriers/far-tracking) describes the same
layout with a placeholder example. No other carrier's rule takes the FAR code, so
`far-international-1` has high confidence.

## Links

`www.far800.com/logistics/result?key=` followed by the number opens a parcel, also under `/en/` in
English. The page takes any number, so the link names FAR only for one in its layout.

## Testing

Set `FAR_INTERNATIONAL_TRACKING_NUMBER` and optionally `FAR_INTERNATIONAL_UNKNOWN_NUMBER` outside
the repository, then run `npm run test:carriers:live -- carriers/far-international`.
