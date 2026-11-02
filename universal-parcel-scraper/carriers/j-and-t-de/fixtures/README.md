# Fixtures

`not-found.json` is the reply of `getDetailByWaybillNo` for a waybill J&T Express Germany does
not know: the waybill is left out of `data`. `delivered.json` and `returned.json` have the shape
and wording of a found waybill's reply: one answer in `data` that names the waybill in `keyword`
and lists its scans in `details`, newest first, each with a time, a sentence and a `signType`.
The times are in UTC, the zone the adapter's request names.

`delivered.json` ends with a delivery left with a neighbour, whose sentence names the delivery
type in brackets and closes with a customer service line. `returned.json` goes through two
delivery runs and a failed delivery to the return.

Waybills, the customer service number and times are invented.
