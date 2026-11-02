# JNE

JNE (Jalur Nugraha Ekakurir) is Indonesia's largest domestic courier. Its JNE Trucking (JTR)
consignments travel under `JT` numbers; its regular parcels travel under a fifteen- or
sixteen-digit resi. Tracked through the guest API of the My JNE app, because the web tracker
asks for the recipient's phone number before it shows a parcel.

## How it works

1. `direct`: one `POST https://apijne.rupibisnis.id/api/login-guest` with an empty body mints an
   anonymous guest token, then one `POST https://apijne.rupibisnis.id/api/l3v14than-res1` with
   that token in the `access-token` header and a body of the number and the app's client code.
   The reply's `cnote` summary and `history` carry the scans, oldest first.

- The token is fetched fresh for each lookup and kept only for that lookup. `clientcode` is the
  app's client code, shipped the same in every install for guest tracking.
- The gateway answers only an `okhttp` client; other User-Agents get an empty reply. So the
  adapter names its own client instead of the host's.
- An unknown number is HTTP 200 with `"status":"04"`. An expired guest token answers `"77"`,
  which a fresh token on a retry fixes.
- The shipment must echo the number asked.

## Notes

- Each scan's `date` is the scanning site's wall clock to the minute, with no zone. Indonesia
  spans three zones (WIB, WITA, WIT) and one history crosses them, so the clocks stay
  `local_time`.
- A scan's description is the leg's English phrase; the station it names travels in brackets and
  becomes the scan's location. A delivery scan's bracket is `recipient | date | city`, so only
  the city is kept. The recipient, the shipper, both addresses, the proof of delivery, the
  signature, the goods description and the price are dropped.
- The summary's `pod_status` of `DELIVERED` decides a delivery; otherwise the newest scan's
  stage stands.
- The reply gives a shipment weight but no delivery estimate, no offset on any clock and no
  partner tracking number.

## Numbers

`jne-1` claims JNE Trucking's `JT` and eleven digits, a shape only La Poste's broad
two-character rule also takes, at low confidence. The regular fifteen- or sixteen-digit resi is
shared with many carriers, so no rule claims it; the adapter still reads one when it is asked.
The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/jne`, with `JNE_TRACKING_NUMBER` and optionally
`JNE_UNKNOWN_NUMBER` set outside the repository.
