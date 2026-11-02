# EGXPRESS

EGXPRESS is Egypt Express's domestic courier network. International FedEx air waybills belong to the FedEx adapter.

The adapter makes the single-shipment guest request built by the [official tracking page](https://www.egyptexpress.com.eg/en-us/tracking-shipment/):
`GET /umbraco/surface/home/GetDomesticTrack` with the whole waybill in `_trackingID`. It needs no session,
account or CAPTCHA. The returned waybill must match before its history is read.

The scan list supplies the current state; empty summary fields do not create events. Clocks keep the
carrier's local date and time without an asserted offset. Delivery descriptions omit the recipient and
identity document, and shipment-level personal, account, cash and package-content fields are discarded.
An empty history is inconclusive. Only the carrier's explicit missing-waybill reply counts as not found;
browser checks, malformed JSON and HTTP failures keep their own error kinds.

The supported waybill shape and public evidence are in [numbers.json](numbers.json). Older bare numeric
labels are outside this adapter's scope. The endpoint leads for reference and bulk searches are separate
from the single-waybill flow and are not used.

Run the live checks with private environment inputs:

```sh
EGXPRESS_TRACKING_NUMBER=... EGXPRESS_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/egxpress/adapter.live.test.ts
```
