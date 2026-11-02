# DEX-I

DEX-I parcels use enabled universal providers. There is no dedicated adapter.

DEX-I (递壹时国际物流, Destinations Express) is a Guangzhou forwarder carrying parcels from mainland China to
Singapore and Malaysia, and door to door to Hong Kong, Macau and Taiwan; Taobao offers it for consolidated
orders to Singapore and Malaysia. 17TRACK lists it as DEX. It has no bare "DEX" alias, since
[DEX Pakistan](../dex-pk/README.md) goes by DEX too.

## Numbers

Its site gives no number layout and no public page shows a DEX-I number, so there is no rule.

## Why there is no adapter

Its tracking page posts the numbers to an open JSON endpoint without a session or CAPTCHA:
`POST api.dex-i.com/api/f/logistics-management/tracking/list` with a JSON array of up to ten numbers. An
unknown number gets HTTP 200 and an empty array. No public number is known to see a found reply.

## Links

The tracking page opens numbers from its `trackingNums` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
