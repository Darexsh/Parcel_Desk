# Vinted Go

Vinted Go's own locker and parcel-shop network in France, Belgium, the Netherlands, Spain,
Portugal and Finland. Tracked through the service its tracking page's search box calls.

## How it works

1. `direct`: one `GET https://carrier.vintedgo.com/public/v3/tracking_events/{number}` with
   `Accept: application/json` and `Accept-Language: en`. The tracker's search box asks this
   service before it opens a parcel's page; it needs no cookies, key, account or browser. The
   reply lists the parcel's scans newest first.
2. `retry`: one more try when the request fails to reach Vinted Go or hangs. The first try gets
   half of the budget.

- The reply does not echo the number: the scans are those of the number in the request's path.
- An unknown number gets HTTP 404 with an empty body: `NotFoundError`. A number whose label is
  over six months old gets 404 with `shipment_expired`, worked out from the number alone, so it
  is inconclusive with the reason `history_expired`. A missing route answers "Not found" in plain
  text, and that, a redirect, another refusal or an empty scan list is inconclusive too. The
  empty scan list carries the reason `portal_not_found`, so a consumer can tell Vinted Go's
  answer from an outage.
- Recognition makes the same request. `vinted-go-1` offers Vinted Go for these numbers next to
  DHL eCommerce, Evri and TNT, so preflight asks this adapter.

## Notes

- Each scan names its milestone (`group`) and its leg (`state`: `delivery`, `return` or
  `dispose`). The provider code joins them, as in `return/in_transit`. Every movement on the
  return leg is `returned`; a loss stays an exception on any leg. A milestone the map does not
  know is left to the shared wording rules.
- The service words scans in the language asked for, so English is asked: the stage map, the
  place rule and the pickup point read English wording.
- A collection is written twice under the same milestone: "Parcel was collected by the
  recipient", then a bare "Delivered" within a second. The second line is left out.
- Clocks are UTC instants. A sorting centre's scan can come dated up to hours after the lookup
  that shows it; such a scan is held back until it is due.
- A scan's location is the town of a sorting centre ("At sorting center in {town}, {country}").
  "In transit to" names where the parcel is going and is not a location. Some towns come with a
  space before the comma, which the location leaves out; a scan stored with it keeps its row.
- The pickup point is the locker or parcel shop a parcel waits at, or was collected from: the
  point the scan before its ready-to-collect scan sends it to, when no redirection comes between
  and both name the same kind of point. Neighbourhood points are not named; they can be someone's
  home. The point's address and id on some scans, the pickup deadline, the banner and the
  questions in the reply are not read.
- The page shows a "New tracking code" with a link to another network on a redirected or
  left-our-network scan. The adapter reads that code as the delivery tracking number, and the
  network from the link when the catalog knows its host. No reply showed one.
- The parcel page is rendered on the server and also answers `RSC: 1` with its React Server
  Components rows, but it leaves out some scans the service lists, so it is not used. Vinted's
  own app needs an account.

## Numbers

Vinted Go numbers are sixteen digits: the label's creation in Unix milliseconds, two more digits
and a Luhn check digit. The service answers a number whose check fails as unknown whatever its
age, and judges the age of one whose check passes from its first thirteen digits. The adapter
takes sixteen digits starting `1` that pass the check. `vinted-go-1` suggests Vinted Go at low
confidence for those starting `17` or `18`, because DHL eCommerce, Evri and TNT accept any
sixteen digits. Other carriers' samples in that range fail the check, so a passing one puts
Vinted Go first wherever the parcel comes from.

Vinted Go also issues `VGS` and thirteen or fourteen digits, with no timestamp or check digit,
and the service answers both lengths like the others. The adapter takes them, and `vinted-go-vgs`
claims them at high confidence: the prefix is Vinted Go's own.

The service also answers codes of sixteen capital letters and digits, mostly letters. The adapter
takes them when an aggregator names Vinted Go for one or the user picks it. No public sample shows
the form. Codes of three letters, a digit, `UW`, a digit and nine letters or digits were answered
with Vinted Go's own scans, so `vinted-go-uw` suggests Vinted Go first for that layout, at low
confidence. `FMP` also opens codes that wrap another carrier's number in another layout.

## Links

Vinted Go's tracker at `vintedgo.com/{language}/tracking` moves to
`vintedgo.com/{language}/tracking/{number}` when a search finds the parcel, so that address
opens one parcel. The page adds the visitor's `country` and `region` to its address. The United
States region has no tracking page, and a visitor placed in it lands on the homepage. The links
name `region=europe`, which opens the tracker from any country.

## Limitations

- No delivery estimate, weight, service, sender or recipient.
- Histories are kept for six months from the label.
- Return-leg handovers to another network are not reported as a delivery partner.

## Testing

`VINTED_GO_TRACKING_NUMBER=... VINTED_GO_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/vinted-go`
