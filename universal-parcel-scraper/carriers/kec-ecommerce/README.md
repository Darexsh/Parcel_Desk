# KEC eCommerce

KEC eCommerce parcels use enabled universal providers. There is no dedicated adapter.

KEC eCommerce (KEC嘉顺达), formerly Kerry eCommerce, is the cross-border e-commerce arm of KLN,
Kerry Logistics Network. It flies parcels from Hong Kong and Shenzhen to Asia, Europe, the US and
Australia and delivers locally in Hong Kong and South-East Asia. Its site is kec.kln.com. It is a
separate brand from [KEX Express](../kex-express-hk/README.md).

## Numbers

Its tracker answers the numbers its shippers upload, including YunExpress numbers, which stay with
[YunExpress](../yunexpress/README.md). Its own older `KECID` numbers have a single public example
that the tracker no longer answers, so there is no rule.

## Why there is no adapter

Its tracking page reads a JSON API with a guest key the page gives every visitor, and it answered
a public number; each event states its UTC offset. An unknown number gets an HTTP 500 error reply,
so the API does not tell a missing parcel from a fault. An adapter is possible and not yet written.

## Links

The tracking page opens numbers from its `tracking` parameter, in English and both Chinese
scripts.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
