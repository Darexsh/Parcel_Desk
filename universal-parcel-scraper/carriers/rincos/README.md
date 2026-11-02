# Rincos

Rincos parcels use enabled universal providers. There is no dedicated adapter.

Rincos (린코스) is an Incheon cross-border logistics firm and the carrier of eBay Korea's eGS
programme. It hands parcels to a carrier in the destination country, such as Sagawa or FedEx.
Its site is rincos.co.kr.

## Numbers

Its tracking numbers are fourteen digits starting with `82`, a length many carriers' rules
accept, so there is no rule.

## Why there is no adapter

Its two trackers render each shipment's history without a session and answered public numbers;
an adapter is possible and not yet written. A result names the destination carrier and its
number. Origin events carry Korean time, destination events the destination carrier's local
time.

## Links

The rincos.asia result page opens a number from its `P_VAL` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
