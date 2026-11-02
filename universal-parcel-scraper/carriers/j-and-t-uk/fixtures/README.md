# Fixtures

`not-found.json` is the reply of `getDetailByWaybillNo` for a waybill J&T Express UK does not
know: the waybill is left out of `data`. `in-transit.json` and `failed-delivery.json` have the
shape and wording of a found waybill's reply: one answer in `data` that names the waybill in
`keyword` and lists its scans in `details`, newest first, each with a scan type `code`, its
Chinese `scanTypeName` and `status`, a time and a sentence. The times are in UTC, the zone the
adapter's request names.

`in-transit.json` goes from the pickup through two sorting centres. `failed-delivery.json` goes on
to the courier's collection for delivery and a problem scan for an incomplete address.

Waybills and times are invented.
