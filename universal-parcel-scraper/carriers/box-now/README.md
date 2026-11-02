# BOX NOW

Tracks BOX NOW locker parcels in Greece, Bulgaria, Croatia, Cyprus and Slovenia through the
anonymous API behind its country sites' trackers.

## How it works

The [Cypriot tracker](https://boxnow.cy/track) posts `{"parcelId": ...}` as JSON to
`https://api-production.boxnow.cy/api/v1/parcels:track`, and the adapter sends that one
request. No account, cookie, key or browser is needed. The sites load an invisible reCAPTCHA,
but only storage extensions, PIN resends and returns send its token; tracking does not. The
Greek site's pages sit behind a Cloudflare challenge, and the Greek, Bulgarian, Croatian and
Slovenian sites post to their own API hosts, which answer the same parcels.

The reply must hold exactly one parcel with the whole requested id. An empty list is what the
trackers show as a number that does not exist, so it is not found. Blocked pages, HTTP errors
and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

BOX NOW's [partner API manual](https://www.boxnow.bg/media/PDF/API%20integration%20manual%20BOX%20NOW%20-%20EN%20v1.69.pdf)
says a parcel id is always ten digits, so other inputs are invalid without a request. Ten
digits are shared with several carriers and nothing in the number points to BOX NOW, so
`box-now-1` only suggests it. Its lookup is one anonymous request that answers an unknown id
with an empty list, so recognition asks it, first for a lookup from one of its countries.

## Notes

The API sends each scan and the parcel's state as a code. The adapter words them as the
partner API manual defines them, else as the trackers' English pages do, and keeps the code.
Like the trackers, the current status follows the newest scan while the parcel's state only
says it is on its way. Scan clocks are UTC instants.

A parcel bound for one of BOX NOW's transfer hubs, such as the hub that passes Vinted's parcels
on to another country's network, ends "delivered" there: a warehouse whose address reads
"transfer" or named as a BOX NOW hub. That delivery is read as a hand-over, in transit, without
the hub's country, a delivery time or the estimate. The reply names no number for the next leg.
A merchant's warehouse, where a return ends, keeps the delivery.

The estimate is kept as the day the trackers print, in Athens, while the parcel is on its way.
The pickup point is the destination locker's name, once the parcel waits there or was
collected from it. The locker's address, photo, notes and coordinates, the pickup deadline,
the compartment size, the payment, the sender and every postcode are dropped. The first scan's
place names the sender, so it has none.

## Limitations

A parcel put back into a locker to be returned is left without a stage: no reply showed
whether it ends the delivery or starts a return to the sender. The trackers' home pages read a
`?track=` query and look the number up, but the catalog has no link for it yet.

## Links

BOX NOW's sites for Greece, Bulgaria, Croatia, Cyprus and Slovenia open one parcel at `/track`
with the number in `?track=`. Such links name BOX NOW.

## Live test

Set `BOX_NOW_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/box-now/adapter.live.test.ts`.
Optionally set `BOX_NOW_UNKNOWN_NUMBER` to check a not-found parcel id.
