# OSM Worldwide

Tracks parcels of OSM Worldwide, the US parcel consolidator, through the service its tracking
page asks.

## How it works

The tracking component on `www.osmworldwide.com/tracking/` asks
`GET https://prod.track-pub.osmworldwide.com/tracking/tracking-request?ids={number}`, without an
account, key, cookie or CAPTCHA token. Without an account it takes one number per request and
holds each reply for a few seconds. A request that fails to reach OSM Worldwide is sent once more
within the budget.

The reply lists one entry, which names the number it answers in upper case. An entry for another
number is a malformed reply. `found` carries the scans, newest first, and `not-found` is the only
missing parcel. HTTP 400, which the service sends for a request it cannot read, stays
inconclusive, as does a missing route. Rate limits, block pages and other HTTP errors keep their
own failure kinds. Recognition uses the same lookup.

## Numbers

The tracker takes four to forty letters and digits. OSM's own package ids are `A`, ten digits, a
three-letter hub code and eight digits, which `osm-worldwide-1` claims, and `OSM` followed by
fourteen letters and digits, which `osm-worldwide-2` claims. Three letters, `IPA` and eight
digits, and five letters and 25 digits were seen too rarely to claim.

Most lookups archived from the tracker are 22-digit USPS package barcodes starting `92`: OSM
hands most parcels to USPS for the last mile, so the USPS rules claim them and recognition never
claims one for OSM. When the caller names OSM Worldwide for such a barcode, the result names USPS
as the delivery carrier, which tracks it under the same number. A USPS routing barcode is sent
without the recipient's ZIP code at its start.

## Notes

- Clocks are wall clocks without an offset and are kept as local times. A parcel's scans come from
  OSM's facilities and its delivery partner, in several time zones, so the reply's order stands.
  Identical rows are kept once.
- The tracker gives the delivery partner's scans OSM codes of their own. Codes are mapped in
  [status.ts](status.ts). A scan the tracker flags as needing delivery instructions is a failed
  attempt and one it flags as an exception is an exception; otherwise the tracker's milestone
  group, then the shared wording rules, decide.
- OSM's FAQ says "Picked Up by Shipping Partner" is made when the label is uploaded, before OSM
  has the parcel, so it is registered. "Package accepted at courier partner" is the last mile
  partner taking the parcel from OSM's facility, so it is in transit, not an acceptance.
- The expected day is kept until the parcel is delivered or an attempt fails, as on the tracker.
- The reply also carries the scans' postcodes and place lines, the scan ids the page sends back
  with delivery instructions, and the shipper's package reference. None of them is read.

## Limitations

The tracker does not name the delivery partner for OSM's own package ids. No live reply for a USPS
barcode was seen. OSM no longer knows older parcels, which come back like unknown ones.

## Links

OSM Worldwide's tracker at `www.osmworldwide.com/tracking/` reads comma-separated numbers from
`trackingIds`, which its own search writes, and from the older `trackingNumbers`. The library
reads the number from either, and `www.osmworldwide.com/tracking/?trackingIds={number}` opens
one parcel.

## Live test

Set `OSM_WORLDWIDE_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/osm-worldwide/adapter.live.test.ts`.
Optionally set `OSM_WORLDWIDE_UNKNOWN_NUMBER` to check a number OSM Worldwide does not know.
