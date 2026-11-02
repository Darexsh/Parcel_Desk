# Transcorp

Transcorp is the GCC logistics group formed when Elite and Transcorp merged. Elite's site now
redirects to Transcorp's, whose tracking page keeps two trackers: Elite's for Elite shipments
across the GCC, and Transcorp's own for the UAE, Saudi Arabia and Qatar. Tracked through the
lookup Elite's tracking page makes while it renders.

## How it works

1. `direct`: one `GET https://app.elite-co.com/shipments/track?references={number}` with
   `RSC: 1`, which asks the Next.js page for its React Server Components instead of HTML. It
   needs no cookie, token, key or browser. The reply holds one component keyed with the
   reference: the shipment with its events, or the backend's message.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 200 with "shipment with reference {number} does not exist". A
  redirect or a 404 is a moved page, and Next's not-found or redirect row in place of the
  answer is a moved route.
- "failed to get shipment" is the backend failing, for known and unknown numbers alike, so it
  is inconclusive.
- The component's key and the shipment's `houseWaybillNumber` must both be the whole number
  asked. The page streams a copy of itself in length-prefixed chunks, which the reader skips.
- Vercel's checkpoint, by its `x-vercel-mitigated` header or its page, is a challenge.
- Recognition makes the same request.

## Notes

- Shipments moved from Elite's legacy portal (`__legacy`) stamp each event with the operating
  country's wall clock read as Dubai time: a scan at 13:20 in Kuwait reads 09:20Z. The
  adapter turns the stamp back into Dubai's wall clock and reads it in the shipment's
  `operatingCountry`; the events' creation stamps agree with the result. Without a country
  with one zone, the clock stays `local_time`. Other events' timestamps are instants.
- Descriptions are the tracker's own labels for the event types, such as `Out For Delivery`;
  the type is the provider code.
- "Picked Up" accepts the parcel only when nothing moved it before. A parcel from abroad is
  picked up again from customs and between hubs, which is in transit. "Returned To Facility"
  comes between delivery runs that did not deliver, so it is in transit too.
- An event's location is its region and country. A region given as a subdivision code, the
  area within it and the coordinates are not kept.
- The destination country is the consignee's, or the operating country of a legacy delivery
  order. The weight is the weighed total, else the declared weight.
- Names, addresses, phone numbers, references, remarks, the courier, the person who received
  the parcel, cash on delivery and the declared value are not kept.
- Transcorp's own tracker is a SuiteFleet page on `transcorpuae`, `transcorp` and
  `transcorpqatar.suitefleet.com`. It calls
  `GET https://api.suitefleet.com/api/public/task-timeline?awb={reference}` with the host's
  tenant in a `clientId` header and no login. Its reference layout is unknown and no public
  reference was found, so the adapter does not use it.

## Limitations

- No delivery estimate: the page shows a placeholder.
- No pickup point, proof of delivery or delivery partner.
- Only Elite airwaybills; Transcorp's own references are not tracked.

## Numbers

Elite airwaybills are ten digits. Two lookups on Elite's tracker that a search engine indexed
and a review on Elite's Trustpilot page give them. Ten-digit runs are shared by many carriers,
so no rule claims them and the gap is declared. Without a rule, preflight does not ask
Transcorp's recognition about them. The adapter sends the ten digits alone, never a partial
reference.

## Links

Lookups on Elite's tracker at `app.elite-co.com/shipments/track` carry the number in
`references`, sometimes also in `awbno`, so
`app.elite-co.com/shipments/track?references={number}` opens one parcel. Transcorp's form opens
`/task/tracking/{reference}` on the tracker host of the chosen country.

## Testing

`npm run test:carriers:live -- carriers/transcorp`, with `TRANSCORP_TRACKING_NUMBER` and
optionally `TRANSCORP_UNKNOWN_NUMBER` set outside the repository.
