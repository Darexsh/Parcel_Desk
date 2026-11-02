# YouBang Express

YouBang Express parcels use enabled universal providers. There is no dedicated adapter.

YouBang Express is 佑邦国际物流 (深圳市佑邦国际物流有限公司, Shenzhen Youbang International
Logistics), a Shenzhen cross-border forwarder whose site is youbangexpress.com. Universal providers
name it YBWL.

## Numbers

No public source shows a whole YouBang Express number. A parcel a universal provider files under
YBWL has `YB`, ten digits and `CN`, so a low rule suggests YouBang Express for that layout; the
corpus holds a made-up number in that shape. Other Shenzhen and Guangdong forwarders share the
initials, so the rule stays low.

## Tracker

The site's tracking page frames a tracker on its own tenant of the Hualei (华磊) forwarder platform,
at `119.29.254.121:8082` over plain HTTP, which answers the platform's interface as
[Huaya Express's](../huaya-express/README.md) does: `selectTrack.htm?documentCode=` without a
cookie, key or CAPTCHA, and `未查询到轨迹` for a number it does not know. A dedicated adapter can
use the shared Hualei client.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
