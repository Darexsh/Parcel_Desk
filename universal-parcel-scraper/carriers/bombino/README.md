# Bombino Express

Bombino Express is an Indian international courier with offices in Mumbai, Dubai, London and
New York. Some last legs go to postal or express partners, whose numbers the tracker shows
alongside. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.bombinoexp.com/api/track/{number}`, as the tracking page asks
   for each air waybill in its address. It needs no cookie, token, key or browser. The JSON reply
   has the shipment's details as label and value rows, its scans newest first, and each piece's
   own copy of them.
2. `retry`: a request that fails to reach the site, or hangs, is sent once more.

- An unknown number is HTTP 200 with `{"errors":["No tracking data found"]}` and no details or
  scans, which the page reports as not found. Any other message is inconclusive. A 404 or a
  redirect is a moved route.
- The site runs on Vercel. Its security checkpoint, as a header or a page in place of the JSON,
  is a browser check, and a plain 429 is a rate limit.
- The shipment must echo the number asked, in `tracking_no` or the details' `AWB No.` row.
- Recognition makes the same request.

## Notes

- Each scan has a wall clock to the second with no zone. Bombino scans in India and at its
  offices abroad, so the clocks stay `local_time`.
- A scan's `event_state` stages it. The reply writes states in snake case (`shipment_hold`); the
  page's script, and the map, compare them without case, spaces, underscores or hyphens, and use
  the script's label for a scan without wording. A hold is an exception until a later scan moves
  the parcel. `rto`, return to origin, is a return, including one the shipper asked for.
- The page files a scan whose wording names customs or a clearance under customs whatever its
  state, so such a scan takes the shared wording rules' stage. A clearance that is done keeps its
  state's stage.
- The forwarding number becomes the delivery tracking number, and its partner the delivery
  carrier, only when the partner's tracking link in the reply carries the number and names one
  catalog carrier. The page shows the number and links to the partner's site without naming it.
- Names, cities, the customer reference, the chargeable weight, the proof of delivery, scan
  remarks and the pieces are not read. A scan's wording loses the consignee's or receiver's name.

## Limitations

- No delivery time as an instant, no weight and no service name.
- No live reply carried a forwarding number, an estimate or a delivery.

## Numbers

Bombino air waybills are plain runs of seven to ten digits, on its current tracker and in
archived lookups from its older pages. No rule claims them, since many carriers print digit runs
of these lengths. A piece's number, the air waybill with two more digits, is not an air waybill
the lookup knows. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Bombino's track page opens one or more air waybills at `www.bombinoexp.com/track?tracking_no=`
followed by the number; the site's search template uses `awb`. Older pages used
`Tracking.aspx?txtAwb=` and `track.aspx?AwbNo=`.

## Testing

`npm run test:carriers:live -- carriers/bombino`, with `BOMBINO_TRACKING_NUMBER` and optionally
`BOMBINO_UNKNOWN_NUMBER` set outside the repository.
