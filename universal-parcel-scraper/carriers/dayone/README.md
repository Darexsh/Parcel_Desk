# DayOne

DayOne is a cross-border fulfilment warehouse whose tracker is dayonetrack.com. It says it is
not a delivery carrier: it ships merchants' orders and its parcels reach the destination
country's courier. The adapter reads the tracker's own lookup for numbers with DOT0; other
DayOne numbers use enabled universal providers.

## Numbers

Its numbers are DOT and sixteen digits. The tracker sends those with DOT0 and DOT1 to its two
lookups, a sample on ParcelPanel's DayOne page and a parcel the tracker answered share the
layout, and no other carrier's rule takes it, so `dayone-1` has high confidence.

## Retrieval

The tracking page asks `GET /api/webservice/Service.ashx` on its own host, without a cookie or
account, and the adapter sends the same request: `method=track`, `param` set to
`{"sp":"","nums":[…]}` and `key` set to the Base64 of that text's MD5 in hexadecimal, as JSONP
(`callbackparam`). It reads the reply in that callback, or bare. One HTTP read, and one more
when the first fails to connect or hangs. The tracker runs on the rtb56 platform, whose request and reply
[YYpost's adapter](../yypost/rtb56.ts) shares with this one.

## Notes

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- Each scan states its place's offset in `gmt_offset`, so its wall clock becomes an instant.
  The tracker lists the scans by wall clock whatever the offset, so a Chinese scan can come
  below an Australian one it followed; with every offset stated, the scans are ordered by
  instant. A scan without a valid offset keeps its wall clock, and the tracker's order stands.
- Scans are the network's English wording without codes: Yanwen's in China, then the
  destination post's. They are staged by DayOne's recorded wording, then the shared rules.
  The first scan's code describes another milestone than the summary's, so scan codes are
  not read. The parcel's summary status is a code, read only when no scan has a stage.
- The destination post's manifest, relayed after the parcel moved, is no step back.
- `channel_hawbcode`, the network's number, becomes `delivery_tracking_number`. Nothing names
  the network, so the hand-off decides who is asked: for an S10 number, the destination's post.
  A parcel handed to YunExpress has one scan here, and its YunExpress number carries the rest.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema
  failure and any other refusal is inconclusive. Redirects, 404s and browser checks are never
  read as a missing parcel.
- The merchant's order reference, the signatory and the proof-of-delivery link are not read.

## Limitations

The page sends DOT1 numbers to `GET https://erp.dayoneerp.com/dayone-api/queryTrackingInfo?id=…`,
which answers HTTP 200 with an empty body for every number tried, so their reply's shape is
unknown. Those numbers, and DOT numbers with another digit after DOT, are inconclusive for
the adapter and left to the providers.

## Links

`www.dayonetrack.com/track?trackNo=` followed by the number opens a parcel.

## Testing

Set `DAYONE_TRACKING_NUMBER` to a DOT0 number and optionally `DAYONE_UNKNOWN_NUMBER` outside the
repository, then run `npm run test:carriers:live -- carriers/dayone`.
