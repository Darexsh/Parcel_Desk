# CouriersPlease

CouriersPlease is an Australian parcel courier owned by Australia Post. It delivers through its
own depots and franchise drivers, sells prepaid satchels and coupons, and hands parcels over at
collection points such as newsagencies. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: `GET https://www.couriersplease.com.au/tools-track` opens a session: the page's
   `csrf-token` meta tag and the `__Host-csrf` cookie it was minted for. Then one
   `POST https://www.couriersplease.com.au/api/track/locate` with `{"trackingCode":"{number}"}`,
   the token in a `csrf-token` header, the cookie and `Sec-Fetch-Site: same-origin`, as the page
   sends it. It needs no key, captcha or browser.
2. `retry`: one more try with a new session when the first fails to reach CouriersPlease or
   hangs. The first try gets half of the budget.

- The JSON reply has one entry for the number: the consignment's labelled details, then each
  item's rows, oldest first. An item's first row names it: a consignment's item label, an SSCC
  or a prepaid coupon's product.
- The service answers only requests a browser marks as coming from its own pages. Without
  `Sec-Fetch-Site` it refuses with 403, "API access is only permitted from the frontend
  application", which the adapter reports as a challenge. A token the service does not take is
  a 403 "CSRF Token Mismatch", which is inconclusive.
- An unknown number is HTTP 200 with "No scan events found" and no rows, or with no items. The
  page reports both as not a valid tracking number. A consignment the reply names without rows
  is known, without a history.
- A reply with `data` null and a message is the service refusing the request itself, so it is
  inconclusive. A 404 or a redirect is a moved route.
- Azure Front Door refuses an address for a while after a burst of requests, the page's own
  assets included, with a 429 page saying "The request is blocked." That is rate limited.
- The tracker matches the whole number in any case. The details' consignment or an item's first
  row must be the number asked: an item label or a coupon has no consignment details.
- Recognition makes the same request, for the numbers `couriersplease-1` claims.

## Notes

- Each row has a date and a time to the minute, with no zone, and the scan's state. The
  details' `Delivered at`, which reads as UTC, matches delivery rows outside New South Wales on
  Sydney's clock rather than the state's. Without an offset in the reply, the rows stay
  `local_time`.
- A row's place is its state, as the page shows it. The depot and its city are not kept.
- The rows the page hides are left out: rows without wording, the page's "Overdue" marker, a
  sender's note that the parcel was despatched to CouriersPlease, and the shipment details a
  sender sends after the pickup.
- Markup is taken out of the wording. A line break ends a sentence, as on the page, and a
  sentence pointing to a link, such as customer support, is dropped.
- A row's whole wording stages it when the help centre lists it, otherwise its kind, kept as
  `provider_code`. A failed delivery's kind also covers parcels held for a problem or refused,
  so the wording comes first. A new delivery date and the receiver's delivery instructions move
  nothing.
- The estimate is the details' `Delivery ETA` until the parcel is delivered or returned. While
  the sender's details are the only row, the page shows it as still to be confirmed, so there
  is none.
- The weight, the volume, the sender's references, the receiver's name or authority to leave,
  `Delivered at` and the driver it names are not kept.

## Limitations

- A consignment of several items merges their rows into one history, and the newest staged row
  gives its stage. One item's delivery can stand for a consignment whose other item is late.
- No service name, and no scan time as an instant.

## Numbers

CouriersPlease's help centre says a consignment number is usually up to fifteen letters and
digits and generally starts with `CP`. Complaints filed against CouriersPlease quote numbers of
`CP`, a letter, a run of letters and digits and six or more digits, fourteen to nineteen
characters in all; `couriersplease-1` claims them. Those of seventeen characters can end like
a French postcode range, which Colis Privé's broad rule also suggests. One complaint quotes a
twelve-character number without the prefix, and archived lookups include all-digit numbers;
those are shapes many carriers share, so no rule claims them. The tracker also answers item
labels and prepaid coupons by their own numbers. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page reads the number from `no` (or `trackingCode`) on
`couriersplease.com.au/tools-track`, fills its field in and looks the number up on load. Its own
search writes the numbers back into `no`.

## Testing

`npm run test:carriers:live -- carriers/couriersplease`, with `COURIERSPLEASE_TRACKING_NUMBER`
and optionally `COURIERSPLEASE_UNKNOWN_NUMBER` set outside the repository.
