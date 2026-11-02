# DPD Romania

Tracks DPD Romania waybills through the anonymous endpoint behind MyDPD's public tracker.

DPD Romania belongs to the Speedy group and runs its platform. Its domestic waybills track only
on DPD Romania's own trackers, not on the DPD group tracker the `dpd` entry uses. Parcels it
hands to the DPD network abroad also carry a DPD group parcel number, which the `dpd` entry
covers.

## How it works

The [MyDPD tracker](https://mydpd.dpd.ro/pub/tracking/) reads a shipment with
`GET https://mydpd.dpd.ro/rest/public/track?id=...&language=en`, and the adapter sends that one
request. No account, cookie, key or browser is needed. The DPD app reads the same path from
MyDPD. `tracking.dpd.ro`, which DPD Romania's site and shop plugins link, redirects to
`services.dpd.ro/tracking/`, which serves a Cloudflare challenge and asks for a Turnstile token
with every lookup, so it is not used.

The reply must name the whole requested waybill. For a waybill it does not know, the endpoint
answers HTTP 404 with MyDPD's "Optiunile specificate nu au fost gasite" page, so that page is not
found. Other 404s, blocked pages, HTTP errors and malformed replies keep their own failure kinds.
Recognition uses the same lookup.

## Numbers

DPD Romania waybills, return waybills included, are eleven digits starting with 8, so other
inputs are invalid without a request. Lookups archived from DPD Romania's tracker, a tracking
guide and an open-source tracking library's test show them. Eleven digits are shared with
Speedy and many other carriers, and nothing in the number points to DPD Romania, so `dpd-ro-1`
only suggests it, and recognition asks DPD Romania only when the lookup's country is Romania. `tracking.dpd.ro` also takes the
fourteen-digit DPD group parcel number of a parcel handed to the DPD network and shows Speedy
waybills of shipments between Bulgaria and Romania. The adapter takes only DPD Romania's own
waybills; the `dpd` and `speedy` entries track the others.

## Notes

The reply has the shape of Speedy's. Each scan carries an operation code from DPD Romania's
[API documentation](https://api.dpd.ro/api/docs/), whose list is Speedy's, so the adapter
stages scans with [Speedy's map](../speedy/status.ts). It keeps the reply's English wording and
the code; the documentation's wording stands in for an empty one. A reply without scans falls
back to the shipment's phase. Scan clocks carry their own offset. A place drops the site type
before the town, such as `or.`, as Speedy's do.

MySpeedy's endpoint does not know DPD Romania waybills and MyDPD's does not know domestic Speedy
shipments, so each carrier asks its own host.

The estimate is the expected delivery day on the shipment-data scan, kept while the shipment is
on its way. Scan comments, which can hold the receiver's name, a proof-of-delivery link or the
return waybill, are dropped. When DPD Romania hands the receiving leg to ACS, as for parcels to
Cyprus, the adapter names ACS and its number, as Speedy's does, so the partner can be asked
when the number is a ten-digit ACS voucher.

## Limitations

Partner networks other than ACS and their numbers are not kept, and pickup points are not
named. A delivery postponed to a later day and the contents-check scans have no stage. A route
MyDPD removed would answer the same 404 page as an unknown waybill.

## Live test

Set `DPD_RO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dpd-ro/adapter.live.test.ts`.
Optionally set `DPD_RO_UNKNOWN_NUMBER` to check a not-found waybill.
