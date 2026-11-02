# Asiafly

Asiafly parcels use enabled universal providers. There is no dedicated adapter.

Asiafly (亚翔, Shenzhen Yaxiang International Freight Forwarding) runs air and sea lines from China
to Australia, handing parcels to Australian carriers, and a postal parcel line to Brazil. Its site
is asiaflyexp.com.

## Numbers

Its site gives no number layout and no public page shows an Asiafly number, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON endpoint, `POST /openapi.php?act=getOrderInfoBySn` with the
numbers in `nos`, without a session or CAPTCHA. An unknown number gets an empty list. No public
number is known to see a found reply.

## Links

The tracking page opens the number from its `no` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
