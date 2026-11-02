# Precision Deliveries

Precision Parcel and Package Deliveries is the Fastfrate Group's final-mile network in Canada.
It was the final-mile division of ASL Distribution and delivers parcels for Amazon and for
shipping platforms such as Stallion Express. ASL Distribution's tracking page sends final-mile
parcels to Precision's tracker. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: an empty `POST` of `{}` to `/api/authentication` on `track.precisiondeliveries.com`
   opens the page's anonymous session: the reply sets a `token` cookie that lasts an hour. A
   `GET` of `/api/shipment-itemId/` followed by the number, with that cookie, answers with the
   parcel and its scans as JSON. It needs no key, captcha or browser. The session serves later
   lookups and is opened again shortly before it ends.
2. `refresh`: a 401 means the service ended the session. A new one is opened and the lookup
   asked once more. A 401 on a fresh session is a challenge.
3. `retry`: the requests once more when they fail to reach the site or hang. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 404 with `{"error":"No item was found","itemId":…}`, naming the
  number. The same answer for another number is inconclusive. A 404 without it, a 410 or a
  redirect is a moved route. A 403 or a bot-check page is a challenge.

## Notes

- The parcel must name the whole number asked in `itemid`. The page also reads a list of
  parcels; the one that names the number is the answer.
- Each scan gives `scandatetime` in UTC and `scandatetimelocal`, the wall clock the page shows.
  Their difference is the scan's offset, and the event keeps the instant with it. The manifest
  row gives the same clock twice, so it does not say which one it is and stays `local_time`, as
  does a difference outside Canada's offsets.
- Amazon parcels carry Amazon's scan codes, other parcels Precision's. The page's own code table
  files the out-for-delivery and delivery codes, which the map follows; the other codes mapped
  are those seen in replies. `Manifest Scan`, code `1`, is the shipper's manifest before any
  physical scan. A code the map does not name falls to the shared wording rules, and a route
  transfer has no stage.
- The estimate is the calendar day of `edd`, dropped after a delivery.
- Every scan repeats the recipient's and shipper's names, addresses, phones and email, and a
  delivered one carries the signer, signature, delivery photos, the driver's name and comments
  and coordinates. None of them is kept, nor the route, hub, account, weight or piece count.
- `tracknum` is the shipper's own reference, such as a shipping platform's number or an Amazon
  reference, not another carrier's tracking number, so it is not a hand-off. The page fetches
  the proof of delivery of some parcels from GLS by Precision's parcel id; the reply names no
  GLS number.
- Recognition makes the same lookup: a parcel is known, the 404 naming the number unknown.

## Limitations

- Return and exception codes have not been seen in replies. The page files its return codes
  under returns, but they are not mapped; their wording goes through the shared rules.
- Scans have no place, and the page shows no service.

## Numbers

Archived replies of its tracking API show two layouts: ASL and ten digits, and PRE, six digits
and five letters or digits. The ASL rule is high because the prefix is the network's former
name and no other carrier uses the layout. The PRE layout has a single sample, so no rule
claims it. A shipping platform's own reference on the same parcel belongs to that platform,
such as stallion-express. The adapter takes the shape the tracking links carry: three letters,
a digit and nine to twenty letters or digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`track.precisiondeliveries.com/` followed by the number opens one parcel. Archived lookups
sometimes repeat the number in a `tracking` query parameter.

## Testing

`npm run test:carriers:live -- carriers/precision-deliveries`, with
`PRECISION_DELIVERIES_TRACKING_NUMBER` and optionally `PRECISION_DELIVERIES_UNKNOWN_NUMBER` set
outside the repository.
