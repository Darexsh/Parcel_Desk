# AllcargoGATI

Gati, later Gati-KWE, is an Indian express distribution company that Allcargo Logistics took
over and now runs as AllcargoGATI. Its branches book and deliver dockets across India, through
transhipment centres between them. Its tracking moved from gati.com to Allcargo's site.
Tracked through the lookup that site's tracking page makes.

## How it works

1. `direct`: two requests to `admin.allcargologistics.com`, as the tracking page makes them.
   - `POST /api/frontend/token` with the body `{}` gives a bearer token. The page asks for one
     on every visit; it lasts five minutes and needs no cookie, key or account.
   - `POST /api/track-shipment` with that token and the body `{"docketNo":"{number}"}`. The JSON
     reply has one entry per docket asked, with the docket's own fields and its scans, newest
     first.

- Both requests carry the site's own `Origin`; the lookup refuses any other with HTTP 403, and
  a request without one or without a valid token with HTTP 401. As the token was just issued,
  either refusal is reported as a challenge.
- The site asks Gati's tracking service behind it. An unknown docket is HTTP 200 with that
  service's `Check Docket No` answer, which is not found. A 404 or a redirect is a moved route.
- Some dockets the service never answers: the site waits thirty seconds, then relays the
  timeout with `success: false`. That reply is inconclusive. The single read gets the whole
  budget rather than half of it with a retry after.
- The site refuses a number that is not nine digits with HTTP 422, which is an invalid input.
- The reply must name the docket asked, in its `dktno` and `docketNumber`.
- Recognition makes the same requests.
- Errors leave out the request details, which hold the token.

## Notes

- Each scan's `intransitDate` and `intransitTime` are a wall clock to the minute, with no zone.
  Every scan is at a Gati branch or transhipment centre in India, which keeps UTC+5:30 all year,
  so the clocks are read in `Asia/Kolkata` and each scan gets a `time`. The delivery time
  `DeliveryDt` has seconds and becomes `delivered_at`.
- A scan's `milestonecode`, such as `DPDCC`, is its `provider_code` and stages it. Its
  `intransitStatus` is the description and names the location a hub scan is about, as in
  `Out For Next Location Chennai`. The reply also gives each scan's location, which the page
  does not show.
- A partial delivery leaves packages on their way, so it is not a delivery.
- The docket's own `docketStatus` decides a delivery, also when a later scan holds the docket.
- The delivery date promised at booking, or its revision, is the expected delivery while the
  docket is not delivered. The booked weight, which the page does not show, is kept.
- The consignor, consignee, receiver, delivery remarks, customer reference, booking and
  delivery stations and the proof of delivery link are not kept.

## Limitations

- No service name, pickup point or delivery partner.
- The tracking form also takes a reference or a mobile number with the receiver's name; the
  adapter looks up docket numbers only.

## Numbers

Gati calls its tracking number the docket number. The tracking form only accepts nine
characters per docket, and customers and archived lookups show nine digits. Nine digits are
printed by several other carriers, so no rule claims them. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

Allcargo's tracking form keeps the number out of its address, so no current address opens one
docket. The former tracker took it as `dktNo` on `gati.com/single_dkt_track_int.jsp` and in the
path of `gati.com/track-by-docket/`; those links are read.

## Testing

`npm run test:carriers:live -- carriers/gati`, with `GATI_TRACKING_NUMBER` and optionally
`GATI_UNKNOWN_NUMBER` set outside the repository.
