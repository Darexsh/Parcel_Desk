# YFHEX

YFHEX parcels use enabled universal providers. There is no dedicated adapter.

YFHEX is 原飞航物流 (深圳市原飞航物流有限公司, Shenzhen Yuanfeihang Logistics), a Shenzhen
cross-border forwarder whose site is yfhex.com. Universal providers name it YFH.

## Numbers

No public page shows a whole YFHEX number, so there is no detection rule. Parcels reach it
through a universal provider's carrier name. Providers name YFH for `HRBC` and ten digits too,
but YFH's tracker did not know such a parcel and Cainiao's answered it, so detection suggests
AliExpress for them.

## Tracker

The home page sends small-parcel and line numbers to `toms.yfhex.com:6055/track_query_c.aspx`
and import parcels to the same page on port 6010 over HTTP. That page shows a new visitor a
slider picture check, and the server refuses the lookup until the check is solved, so a dedicated
adapter needs to handle that check.

The home page's express lookup asks `api.yfhex.com:8443/getTracking?firstbillid=` without a check.
It answers an empty list for a number it does not know. No public page shows a number it tracks, so
its replies are unverified.

## Links

The port 6055 tracker writes the number in `?track_number=` into its query box.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
