# Shipa

Shipa Delivery is Shipa's last-mile delivery service in the United Arab Emirates, Saudi Arabia
and Kuwait, for shops and for imports cleared on arrival. Tracked through the lookup Shipa
Delivery's tracking page makes.

## How it works

1. `direct`: one `GET https://apiv2.shipadelivery.com/{application id}/{key}/services/whl/v2/my-packages/{number}`
   with the header `X-Order-Story-Version: v2`, as the page at `tracking.shipadelivery.com/?bc={number}`
   sends it. The application id and key are the page script's own, the same for every visitor,
   so the adapter carries them. The JSON reply is the order with its story, oldest first.
2. `retry`: a read that fails to reach the service, or hangs, is sent once more inside the budget.

- An unknown number is HTTP 404 with `{"code":50007,"message":"Order not found"}`. Another 404,
  or a `Service method not found` error, is a moved route. HTTP 401 with code 2002 means the
  service no longer accepts the page's key.
- The order must be the whole number asked.

## Notes

- Shipa's own tracking page on shipa.com asks `api.shipa.com` which of its services holds a
  number and forwards SD numbers to Shipa Delivery's page. That router answers any SD number,
  known or not, so the adapter skips it.
- Each status's `date` is an instant in epoch milliseconds, which the page shows to the second
  in the visitor's own zone, so scans keep it as `time`.
- The status code stages a scan and is its provider code; a code the map does not know falls to
  its name. A failed pickup or delivery carries a reason from Shipa Delivery's list, such as
  `Can't reach the Customer - No Answer`, which is appended to the status name.
- `Pending Delivery Confirmation` and `Rescheduled` follow the status before them within a
  second and move nothing, so they have no stage and the status before them sets the current
  one.
- The location is the town the page shows. The courier or hub name beside it is not kept.
- The estimated arrival is the day the page shows, read in the country of the Shipa office
  that handles the order. Like the page, the adapter drops it once the parcel is delivered,
  and also once it is returned or the day is past.
- The reply also holds the pickup and drop-off coordinates, the order's countries, proof photos,
  the rescheduled delivery times and Shipa's support number. None of it is kept; a returned
  order's countries did not match its story.
- No recognition: `shipa-1` already selects Shipa for SD numbers.

## Limitations

- No weight, service or pickup point.
- Only SD numbers: other Shipa services, which shipa.com's router sends elsewhere, are not read.

## Numbers

Shipa Delivery tracking numbers are `SD` followed by nine digits. Customers quote them in
reviews that Shipa answers. `shipa-1` claims the layout. GLS Italy's broad rule also accepts
it, and the `SD` prefix decides.

## Links

`shipa.com/track/?trackingno={number}` opens one parcel: Shipa's tracking script reads the
number from `trackingno` and forwards it to Shipa Delivery's page. Links to Shipa Delivery's
own tracking page carry a message code rather than the tracking number, so the library reads
no number from them.

## Testing

`npm run test:carriers:live -- carriers/shipa`, with `SHIPA_TRACKING_NUMBER` and optionally
`SHIPA_UNKNOWN_NUMBER` set outside the repository.
