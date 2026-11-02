# XLmiles

XLmiles parcels use enabled universal providers. There is no dedicated adapter.

XLmiles (迅迈物流), whose logo reads Xmiles, is the brand of Xmiles Technology Inc, a Fontana, California
carrier delivering online shops' parcels across the United States, TikTok Shop's among them, with road
freight and warehousing. Its sites are xlmiles.com and myxmiles.com, which serve the same pages.

## Numbers

Its site gives no number layout, and its tracker also finds a parcel under the number a partner gave it. No
public page shows an XLmiles number, so there is no rule.

## Why there is no adapter

Its tracking page posts the numbers to an open JSON endpoint without a session or CAPTCHA:
`POST www.xlmiles.com/api/track` with `{"tracking_numbers": [number], "hasDeliveryUrl": true}` and an
optional US zone in `timeZone`; without one, scan times are local wall clocks. An unknown number gets HTTP 200
with an empty `data` list. A found parcel's record carries XLmiles's own number and the partner's, and the
tracker matches either, so an adapter has to check which one it asked for. The page hides scans whose
`subStatus` is 32. The record also carries the recipient's postcode, which unlocks the delivery photo; an
adapter must leave both out. No public number is known to see a found reply.

## Links

The tracking page opens numbers from its `trakno` parameter and the home page from `tracking_number`, on
xlmiles.com and myxmiles.com alike.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
