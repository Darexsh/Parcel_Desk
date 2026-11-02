# UBI Smart Parcel

Tracks UBI Smart Parcel's cross-border parcels from China, and their hand-over to the carrier
that delivers them, through the service UBI's public tracker asks.

## How it works

UBI's tracker is the `#/ubi` page of its shipper portal, a WallTech eTower site. It sends
`POST https://shipper.ubismartparcel.com/api/aggregator/v1/track/trackParcel` with the number and
the portal's host as `serverName`, without an account, key, cookie or CAPTCHA token. A request that
fails to reach UBI is sent once more within the budget.

The reply lists the numbers asked for and those UBI does not know, then the parcels it found, each
naming the number it was asked by. A parcel counts only for the whole number asked, and a number
listed as unknown without a parcel is the only missing parcel. The service turns down a request it
cannot read with HTTP 200 and an error code, which stays inconclusive. Rate limits, block pages and
other HTTP errors keep their own failure kinds. Recognition uses the same lookup.

## Numbers

The tracker takes six to forty letters and digits. UBI's own numbers for Australia are `AU` and
thirteen digits, issued in one dense run; `ubi-smart-parcel-1` offers that shape at low
confidence, so recognition asks UBI about it. Parcels to Canada carry a sixteen-digit Canada
Post number from the start, a length several carriers share. The tracker also finds a parcel by
its partner's number, such as an Australia Post barcode: those numbers stay with the partner, and
recognition never claims a parcel found that way.

## Notes

- A parcel's history mixes UBI's hub scans in China, UBI's own scans abroad and the delivering
  carrier's scans, which UBI relays under its own event codes with the partner's wording beside
  them. Each has a wall clock and a zone label.
- The hub scans in China are on China's clock, as the service's recording times confirm, and keep
  their offset. UBI's labels abroad ignore daylight saving time, so its own scans outside China are
  kept as local times. A relayed scan keeps the partner's offset once the service recorded it after
  that instant: Australia Post's follow each state's daylight saving time, and Canada Post's match
  its own tracker. A relayed scan labelled with China's offset is the partner's wall clock
  (Aramex's) and is kept as a local time. Scans are ordered by their labelled instant.
- UBI lists the flight it books from its hub ahead of time. That scan is left out until its time
  comes. Identical scans under the parcel's two numbers are kept once.
- Codes are mapped in [status.ts](status.ts); `SCN` and `INF` cover several scans, so their wording
  decides. A partner's manifest after UBI has the parcel is no step back, and a partner's notice of
  a new delivery estimate has no stage.
- The delivering carrier is named in `delivery_carrier` when the catalog knows the site the tracker
  links for it, and its number, the parcel's other number, in `delivery_tracking_number`. The
  site's opening hours are never read, and a place part holding a digit is dropped as a possible
  postcode.

## Limitations

The tracker gives no delivery estimate, and it names no partner site for parcels to Canada. UBI no
longer knows older parcels, which come back like unknown ones.

## Links

The tracker reads comma-separated numbers from `trackingNos=` after the hash. The library reads the
first, and `shipper.ubismartparcel.com/#/ubi?trackingNos={number}` opens one parcel.

## Live test

Set `UBI_SMART_PARCEL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ubi-smart-parcel/adapter.live.test.ts`.
Optionally set `UBI_SMART_PARCEL_UNKNOWN_NUMBER` to check a number UBI does not know.
