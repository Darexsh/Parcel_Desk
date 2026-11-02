# RedX

RedX is a Bangladeshi courier that picks up online orders from merchants and delivers them,
often cash on delivery, across Bangladesh through its own hubs and riders. Tracked through the
lookup its public tracking page makes.

## How it works

1. `direct`: one `GET https://api.redx.com.bd/v1/logistics/global-tracking/{id}`, as the public
   tracking page asks it for the ID in its address. It needs no cookie, token, key or browser.
   The JSON reply lists the scans, oldest first, each with its English and Bengali wording, the
   action that recorded it and a UTC instant.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown ID is HTTP 200 with `{"isError":true,"message":"No parcel data found!"}`, which
  the page reports as no parcel found. A 404 or a redirect is a moved route, and a 403 with
  `No token found!` is a route that now asks for a signed-in merchant.
- Cloudflare, in front of the service, answers some clients with a 403 page or a browser check,
  which is a challenge. The package's default User-Agent passes.
- The reply names no ID. The service matches the whole ID in the path, ignoring case, and a
  shorter or longer one is unknown to it, so the path binds the reply to the ID asked.
- Recognition makes the same request.

## Notes

- Scan times are UTC instants: the page shows them in the visitor's own zone. Bangladesh keeps
  one zone, so scans are returned at `+06:00`.
- A scan's `action`, such as `dispatched-to-agent`, stages it and is its provider code. The
  `status` beside it names the parcel's state and repeats for unrelated scans. An action the map
  does not know falls to the wording rules. The newest staged scan sets the parcel's stage.
- A hold after a delivery run is a failed attempt; its wording carries RedX's reason in Bengali.
- The rider's name, phone number and the areas they serve follow "by" in the out-for-delivery
  wording and are taken out, as are phone numbers anywhere else. The Bengali wording is not
  kept.
- The page also asks `/parcel-track/{id}` for the customer's name and area, the weight, the
  cash to collect and the delivery hub's contact details. The adapter does not make that
  request.

## Limitations

- No scan locations other than the hub names in the wording, no weight, no delivery estimate
  and no proof of delivery.
- Parcels booked a few years back are unknown to the tracker.

## Numbers

RedX tracking IDs are the two-digit year, the month and the day the parcel was booked, each
under ten written as `A` and the digit, then the weekday's first two letters and the parcel's
serial in base 36, twelve to fourteen characters in all. Archived replies of RedX's tracker and
its developer documentation show them, and `redx-1` claims the layout. The adapter asks only
for IDs of that layout. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The home page's tracking field sends the ID as `trackingId` to `/track-global-parcel/`, so
`redx.com.bd/track-global-parcel/?trackingId={number}` opens one parcel. Merchants who are
signed in are sent to `/track-parcel/` with the same parameter.

## Testing

`npm run test:carriers:live -- carriers/redx`, with `REDX_TRACKING_NUMBER` and optionally
`REDX_UNKNOWN_NUMBER` set outside the repository.
