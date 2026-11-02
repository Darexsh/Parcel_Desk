# C3X

C3X (C3X International Couriers) is a Dubai courier of the Bin Yaber Group. It delivers in the
United Arab Emirates and ships abroad. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://api.c3x.ae/api/Tracking` with the body
   `{"TrackingAWB":[{"AirWayBillNo":"{number}"}]}`, as the tracking field on `c3xpress.com`
   sends it. It needs no cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- The JSON reply has an entry for the airwaybill with its scans newest first. For an airwaybill
  C3X does not know, the entry holds the number and nothing else, which the page reports as
  not found. A known airwaybill whose entry has details but no scans has no history yet.
- The service answers HTTP 400 with a message when C3X's own system fails, which is no answer
  about the parcel. A 404 is a moved route.
- The entry must carry the number asked.
- The page also looks parcels up by the shipper's reference or a booking number. The adapter
  sends airwaybills only.
- Recognition makes the same request.

## Notes

- Each scan's `ActivityDate` and `ActivityTime`, such as `Friday 06 December 2024` and
  `13:11`, carry no zone, so the clocks stay `local_time`.
- A scan's description is its `Remarks`, and its `Status` (`POD`) stages it. The shipment's
  details can reach C3X after the parcel did, so a later "Shipment Information Received"
  does not take a parcel that has moved back to registered.
- The destination, such as `ABU DHABI-UNITED ARAB EMIRATES`, gives the destination country.
- `ForwardingNumber` is the forwarding agent's number for a parcel C3X hands on. It becomes
  `delivery_tracking_number`. The reply names no agent, so there is no `delivery_carrier`,
  and the hand-off goes by the number's own rules.
- The page shows who took the parcel beside the delivery scan. The adapter drops that name,
  phone numbers in a scan's wording, the proof-of-delivery images, the shipper's references,
  the origin, the progress rail and the weight, which comes without a unit.

## Limitations

- No ETA, service or delivery instant with a zone.

## Numbers

C3X airwaybills are ten digits. Ten-digit runs are shared by many carriers, so no rule claims
them and the gap is declared. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking field on `c3xpress.com` sends the number to C3X's API and shows the history in
place. No address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/c3x`, with `C3X_TRACKING_NUMBER` and optionally
`C3X_UNKNOWN_NUMBER` set outside the repository.
