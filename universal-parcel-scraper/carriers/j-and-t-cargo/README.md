# J&T Cargo

Tracks J&T Cargo Indonesia masters and individual pieces, a separate freight network
and tracking system from [J&T Express](../j-and-t/README.md).

## Retrieval

One anonymous `POST` to the
[official history endpoint](https://office.jtcargo.co.id/official/waybill/trackingCustomerByWaybillNo)
sends the whole waybill, `langType: "EN"` and `searchWaybillOrCustomerOrderId: "1"`.
It needs no phone digits, account token, cookies or preceding verification call.
The [tracking page](https://www.jtcargo.id/networkQuery) asks for the last four digits
of the sender's or recipient's phone number in its own flow.

The reply's `keyword` and every scan's `billCode` must match the requested identifier.
Masters and pieces have separate histories; a piece is never replaced by its master,
and another piece's delivery cannot complete the requested consignment.
The [mapping endpoint](https://office.jtcargo.co.id/official/waybill/getMainSubBillCode)
lists published piece identifiers but can retain a supplied piece as `mainBillCode`.
It is not needed for an exact history read, and piece suffixes are never inferred.

## Notes

The feed's fixed scan labels and codes establish progress. Its customer messages,
remarks, staff details and proof links are dropped because they contain personal data.
`sendCode` describes the delivery service mode rather than a shipment milestone.
Consignment totals are omitted because a piece's reply can repeat the master's totals.

Scan clocks stay in `local_time`: the feed gives no offset, and Indonesia has three
zones. The API's newest-first order is preserved. Facility town and province describe
the scan location, including departures; upload clocks are not scan clocks.

An unknown waybill returns an echoed identifier with null shipment fields inside a
success envelope. That placeholder remains inconclusive, as does a history without
scans. The placeholder carries the reason `portal_not_found`, so a consumer can tell
J&T Cargo's answer from an outage. HTTP endpoint failures and verification responses
are never parcel absence.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-cargo` uses private
`J_AND_T_CARGO_TRACKING_NUMBER`, `J_AND_T_CARGO_PIECE_NUMBER` and
`J_AND_T_CARGO_UNKNOWN_NUMBER` inputs when supplied.
