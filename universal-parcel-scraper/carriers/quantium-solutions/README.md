# Quantium Solutions

Quantium Solutions is a Singapore e-commerce logistics company with cross-border, warehousing
and last-mile services in Asia Pacific. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://itapps.quantiumworldwide.com/itcms_tracking/api/itcommon/general_sql`
   with the body
   `{"query_name":"itcms_sql\\d_order_track","query_json":"{\"cust_code\":\"\",\"order_no\":\"{number}\"}"}`,
   as the page that `track.quantiumworldwide.com` frames sends it. It needs no cookie, token or
   browser. The JSON reply lists the shipments found, each with its history as an XML string.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with an empty list, which the page shows as "No record!". The
  service's own failure is HTTP 500 with a .NET exception, which is inconclusive. A 404 or a
  redirect is a moved route.
- The lookup matches the whole number in any case, as the shipment's order number or as the
  tracking number the page prints beside it, and not a part of one. The adapter keeps the
  shipment whose order number is the number asked, else the one whose tracking number is.
- Recognition makes the same request.

## Notes

- Each scan has a milestone and, for the scans a partner relays, a remark naming the partner's
  own milestone. The wording is the milestone, then the remark after a colon when it says more,
  as `IN TRANSIT: Customs Clearance Begins`. The remark stages the scan where it is known,
  since the catch-all `IN TRANSIT` milestone can hold the start of customs clearance.
- Scan clocks are wall clocks to the second with no zone. One history holds Quantium's own
  scans and the destination partner's, whose delivery rounds read as the recipient's local
  time, so the clocks stay `local_time` and the history keeps the reply's order rather than
  being sorted by them.
- The reply also holds the shipper's and the recipient's names and addresses, which the page
  does not show. The adapter reads none of them, nor the states, the client reference or the
  origin. A delivery remark loses a clause naming who took the parcel, and every wording loses
  phone numbers.
- The page prints the tracking number of the partner that carries the parcel on, but never names
  the partner, so there is no hand-off.

## Limitations

- No scan locations, codes, estimate or weight.
- The current lookup does not find a shipment by its client reference, and finds nothing for
  the `UQM-MU` and `UQT-TU` references the former tracker answered, so the adapter takes
  tracking numbers only.

## Numbers

Archived lookups on Quantium's former tracker show ten-digit tracking numbers for Malaysian
shipments and UQ, nine digits and TH for Thai ones; the current tracker also follows parcels
under the Singapore Post S10 numbers they carry. The adapter takes ten digits and the S10
layout, valid check digit or not. No rule claims these: ten digits are printed by many
carriers, and S10 numbers are left to postal detection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`track.quantiumworldwide.com/?trackno={number}` opens one parcel: the tracker reads `trackno`
and frames its result, `itapps.quantiumworldwide.com/itcms_tracking/Widget/order_track`, with
`as_order_no`. Links to either name Quantium. The former tracker `track.quantiumsolutions.com`
used the same `trackno` parameter.

## Testing

`npm run test:carriers:live -- carriers/quantium-solutions`, with
`QUANTIUM_SOLUTIONS_TRACKING_NUMBER` and optionally `QUANTIUM_SOLUTIONS_UNKNOWN_NUMBER` set
outside the repository.
