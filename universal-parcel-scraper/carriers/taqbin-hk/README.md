# TA-Q-BIN Hong Kong

The adapter reads Hong Kong waybill history from Yamato Logistics (HK)'s guest tracking service.
Yamato's other national networks remain separate carriers; an overlapping waybill shape establishes
no ownership, so this carrier adds no detection or recognition rule.

## How it works

`direct` posts one whole waybill as `keyTrackingNumber` to
`https://delivery.message.sg/YTHKws/wsWebsite.asmx/external_waybill_fetchStatusLog`, following the
official widget's [request builder](https://delivery.message.sg/YTHKtracking/trackitems.js) and
[service configuration](https://delivery.message.sg/YTHKtracking/js/custom.js). It needs no session
or CAPTCHA. `retry` repeats only a request that failed to connect or timed out, within the same budget.

The reply is bound by its single-waybill request; it does not echo an identifier. Scans keep their
local clocks and their original precision. Delivery reasons and operator names are omitted because
they can identify people, and the contactless-delivery capability lookup is not called.

## Limitations

An empty scan list can mean absent or expired waybill history. It remains inconclusive, allowing
enabled universal providers to try. The native adapter accepts only the verified waybill branch.

The separate e-commerce tracker uses `/pms/v1/parcels/parcel/{number}` on api.yamatohk.com.hk with a
shared guest key from its public page. Native retrieval for that system is unsupported; its parcel
formats and service routing are not detection evidence for the waybill branch. Numeric inputs the
official homepage routes to e-commerce also remain unsupported.

## Links

The tracking page on app01.yamatohk.com.hk opens numbers from its `trackingNo` parameter and hands them to the
message.sg page, which takes them in `a`. The e-commerce tracker on pms.yamatohk.com.hk takes them in `track`.

## Testing

Set `TAQBIN_HK_WAYBILL_NUMBER` for a private known waybill and `TAQBIN_HK_UNKNOWN_WAYBILL` for a private
unknown control, then run `npm run test:carriers:live -- carriers/taqbin-hk`.
