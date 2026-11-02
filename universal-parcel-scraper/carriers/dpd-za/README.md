# DPD South Africa

DPD South Africa, formerly DPD Laser, is DPD's network in South Africa, partnered with
DPD's owner Geopost, and its site on dpd.com now presents it under that name. Dawn Wing, its
domestic courier brand, and Fast & Furious, a courier it bought in 2021, were folded into it,
and dawnwing.co.za and dpdlaser.co.za redirect to that site. Tracked through the lookup of the parcel tracker app its tracking page frames.

## How it works

1. `direct`: one `GET https://website.dpdl.co.za/s/QuickTrack?waybillNo={number}&includeRelatedWaybills=true&includeCollectionTrackingEvents=true`,
   as the tracker app sends it. It needs no account, cookie, token, postcode or browser. The
   JSON reply has the waybill's summary and its scans.
2. `retry`: a lookup that fails to reach the tracker, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- An unknown waybill is HTTP 200 with an empty body. The app then stays on "Searching for
  waybill"; its own not-found notice is for a `waybillId` of 0, which the adapter also reads as
  not found. A known waybill without scans has no history.
- A 403 or Cloudflare's bot check is a challenge, a 429 is rate limited, and a redirect or a 404
  is a moved route.
- The tracker finds only the whole waybill, and the reply's `waybillNo` must be the number
  asked: a lookup without a number answers with some other waybill.
- Recognition makes the same lookup.

This is DPD South Africa's own system, not the group tracking service DPD's European networks
share, and it does not know their fourteen-digit parcel numbers.

## Notes

- Each scan's `dateAndTime` is the wall clock the app shows, with no zone. It fits South
  Africa's time, as the delivery scan's clock matches the delivery time its wording gives, but
  the reply says nothing of a zone, so the clocks stay `local_time`.
- A scan's wording is the `longDescription` the app shows. The reply appends the scan's branch,
  which becomes its location. The delivery wording names who took the parcel and when, and a
  failed round gives DPD South Africa's phone number and email address; the adapter leaves those
  out. The reply's other notes, such as linehaul manifests, trips and parcel sizes, are not kept.
- The `trackingEventTypeId` stages each scan and is its provider code. A delivery day booked
  with the recipient moves nothing. The map is in [status.ts](status.ts).
- The summary's `opsStatusId` drives the app's progress rail. Its delivered and exception
  values decide the parcel's stage, because manifest and proof-of-delivery scans can come after
  a delivery. Otherwise the newest staged scan does, as it is more precise than the rail.
- The depot's copy of a scan names its branch, and the reply can repeat it without one at the
  same second; the copy without a branch is dropped. Scans the app hides, marked not to be shown
  or without wording, are left out.
- The recipient's name, the sender's and recipient's towns, the delivery time, the target
  delivery date the app does not show and the related waybills are not kept.

## Limitations

- No ETA, weight, service, sender, proof of delivery or delivery instant with a zone.
- The scans of a parent or child waybill the reply names are left out; that waybill is tracked
  on its own.
- Older waybills drop out of the tracker and then read as not found.

## Numbers

DPD South Africa tracks by waybill number. Its former Dawn Wing tracker shows two letters and
seven digits, and its tracking page was asked for numbers that start with two or three letters
and continue with five to thirteen digits, as well as shop-prefixed waybills such as
OneDayOnly's. The letters name an account, branch or shop rather than DPD South Africa, and the
same shapes are used by other carriers, so no rule claims them and preflight does not ask DPD
South Africa. Fourteen-digit numbers, the parcel layout of DPD's European networks, were looked
up there too; the tracker does not know them, and they stay with those networks. The adapter
takes six to thirty letters and digits with at least one digit, and refuses anything else
without a request. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

DPD South Africa's tracking page sends the whole number as the query string to
`www.dpd.com/za/en/receiving-parcels/track-my-parcel/tracking-details/`, so
`www.dpd.com/za/en/receiving-parcels/track-my-parcel/tracking-details/?{number}` opens one
parcel. That page frames the tracker app at `website.dpdl.co.za/parceltrack/{number}`. Dawn
Wing's former tracker took the number as `WaybillNo` on
`dawnwing.co.za/business-tools/online-parcel-tracking/`.

## Testing

`npm run test:carriers:live -- carriers/dpd-za`, with `DPD_ZA_TRACKING_NUMBER` and optionally
`DPD_ZA_UNKNOWN_NUMBER` set outside the repository.
