# Online Worldwide

Online Worldwide parcels use enabled universal providers. There is no dedicated adapter.

Online Worldwide (欧莱国际货运), run by 广州市欧莱国际货运代理有限公司 in Guangzhou, ships goods from
China door to door, duties paid, to Saudi Arabia, the United Arab Emirates, Kuwait, Qatar, Oman,
Bahrain, Lebanon and India by air and sea, with offices in Riyadh and New Delhi. Its site is
online56.com.cn.

## Numbers

The tracker's placeholder shows one example waybill number of eleven digits. No other public page
shows one, a single example does not show how its numbers are built, and many carriers print
eleven-digit runs, so there is no rule.

## Why there is no adapter

The tracking page fills the number from its `sn` parameter and asks a JSON endpoint on the same
site with it, without a session. No public number has shown a known parcel's reply yet. An
adapter can follow.

## Links

Tracking links carry the number as `sn` on the cargo tracking page, which runs the search on
load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
