# SkyKing

SkyKing is an Indian courier that delivers documents and parcels door to door through branches
across India. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: two `GET` requests to `live.skyking.co`, as the tracking page makes them.
   - `/api/Track/GetAPIKeyValue` gives a key, a base64 string. The page asks for one on every
     visit; it needs no cookie, captcha or account.
   - `/api/Track/ConsignmentMTrack_WebSite_AuthNew` with `cnote={number}`, the page's own
     `key=skm` and `Email=skm@flyking.co.in`, and the key in a `KeyValue` header. The JSON reply
     lists the consignment's scans, oldest first, each naming the consignment.
2. `retry`: a request that fails to reach the service, or hangs, is sent once more within the
   budget, with a fresh key.

- An empty list is what the page shows as "No Tracking Information Available.", which is not
  found. The lookup gives the same empty list without a valid key, so each lookup asks for a
  fresh one first; a key the service rejects gets HTTP 500, which is inconclusive.
- A partial number, or one with a digit added in front, gets the empty list too, not someone
  else's consignment. Every scan must still name the whole number asked.
- A 404 or a redirect is a moved route. Errors leave out the request details, which hold the
  key.
- Recognition makes the same requests.

## Notes

- Each scan's `DateTime` is a wall clock to the second, such as `14/09/2026 - 16:18:09`, with
  no zone. The scans come from SkyKing's own system, whose other lookup on the page,
  `LastTrackingDateTime`, gives its current date and time on India's clock. Every scan is at a
  SkyKing branch or hub in India, which keeps UTC+5:30 all year, so the clocks are read in
  `Asia/Kolkata` and each scan gets a `time`.
- Scans come without a code. SkyKing's own wordings stage them: `INBOUND SCAN DONE` and
  `FORWARDED TO …` are in transit. `Un-Delivered` is a failed delivery, which the shared
  wording rules would read as a delivery. A return to origin, worded `RTO …`, is an exception
  until it is delivered back, then returned.
- The location is the branch or hub the scan names.
- An out-for-delivery scan loses the delivery area and the courier's name listed after its
  wording, a delivery loses how it was signed for and its run sheet item number, and every
  wording loses phone numbers. The reference, branch and location ids, manifest kinds and the
  proof of delivery and booking images in the reply are not kept.

## Limitations

- No expected delivery, service name, origin or provider code.
- Older consignments, from a few months back, get the same empty list as unknown ones, so not
  found also covers a consignment SkyKing no longer keeps.
- SkyKing's Android app asks for the same key and makes a sibling lookup,
  `ConsignmentMTrack_Mobile_AuthNew`; the adapter uses the page's.

## Numbers

SkyKing consignment numbers are nine digits, and eight on older consignments. The lookup
answers a number with letters with an empty string, so the adapter takes digits only. Both
lengths are bare digit runs that other carriers print too, so no rule claims them and
preflight does not ask SkyKing: a number reaches the adapter when the user, a link or a
provider names the carrier. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`skyking.co/track?cno={number}` opens one consignment; the tracker's own share buttons build
that address. The library reads the number from `cno`.

## Testing

`npm run test:carriers:live -- carriers/skyking`, with `SKYKING_TRACKING_NUMBER` and optionally
`SKYKING_UNKNOWN_NUMBER` set outside the repository.
