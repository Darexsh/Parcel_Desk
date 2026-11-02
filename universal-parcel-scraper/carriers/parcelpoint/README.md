# ParcelPoint

ParcelPoint is HUBBED's network of pickup and drop-off points in Australian shops, branded
PARCELPOINT. Partner carriers such as Australia Post, CouriersPlease, Aramex and Team Global
Express deliver parcels to the points and collect returns from them, so a parcel waiting at a
point usually also has its carrier's number. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://parcelpoint.com.au/wp-json/parcelpoint/v1/track?trackingId={number}`,
   the site's proxy to HUBBED's tracking service, which the tracking page asks with the number
   in capitals. It needs no cookie, key or browser: the WordPress nonce the page sends only
   guards signed-in sessions. The JSON reply has the parcel's current status, its numbers and
   its events at the point.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with the number asked and every other field empty, which the
  page shows as a parcel without events and the adapter reads as not found. The page reads a
  404 from the proxy as not found too; WordPress's `rest_no_route` 404 is a moved route.
- When the service behind the proxy does not answer, the proxy replies HTTP 502
  `upstream_error` after about fifteen seconds, which is inconclusive. Some all-digit numbers,
  such as long runs of zeros, always get it.
- The reply must echo the number asked and give it as the parcel's consignment id, booking code
  or reference.
- No recognition: no detection rule offers ParcelPoint.

## Notes

- Each event's `date` is UTC to the minute. The page's script reads it so before showing it in
  the visitor's zone, and the delivering carrier's own scans of the same handovers agree, so the
  clocks are instants.
- An event's place is the point's shop name. It becomes `pickup_point` while the parcel waits
  there and once it was collected there.
- The codes say what happened at the point: `BOOKED` when the carrier booked the parcel to it,
  `CHECKED_IN` when the point received it and `CHECKED_OUT` when it left. Points also hand
  returns to the carriers that collect them, so a check-in is ready for collection, and a
  check-out the recipient's collection, only with the wording seen for those. Other wording
  falls to the shared rules.
- The check-in's wording names the delivering carrier. The adapter does not make it a hand-off:
  the number asked is usually that carrier's own already.
- The tracker on hubbed.com posts the number to `hubbed.com/new-get-token/` and answers with
  HTML from the same service. It shows its not-found notice also when the service does not
  answer, so the adapter reads parcelpoint.com.au instead.

## Limitations

- Only the parcel's steps at the point. Its journey before is in the carrier's own tracker.
- No collection code, recipient, estimate or weight. The collection code goes to the recipient
  by SMS or email.
- A number reaches the adapter only when ParcelPoint is chosen or a ParcelPoint link is opened.

## Numbers

The tracker opens a parcel by its PARCELPOINT booking code, by the number of the carrier that
brought it or collects it, or by its reference, so the adapter takes six to forty letters and
digits with a digit. ParcelPoint's oldest archived lookups show references of four to six
letters and digits starting with 60 or 70, a dash and eight letters and digits. No public
source shows the layout of the current booking codes, and the carriers' numbers stay with their
own rules, so detection does not offer ParcelPoint.

## Links

`parcelpoint.com.au/track-your-parcel/` with `trackingnumber` or `trackingId` opens one
parcel, and the tracker rewrites its address to that form after a search. Older links put the
reference in the path, `/track/<reference>`. On hubbed.com, `/track-parcel/` reads `locate` or
`hubbed_track_parcel_tracking_no`.

## Testing

`npm run test:carriers:live -- carriers/parcelpoint`, with `PARCELPOINT_TRACKING_NUMBER` and
optionally `PARCELPOINT_BOOKING_CODE` and `PARCELPOINT_UNKNOWN_NUMBER` set outside the
repository.
