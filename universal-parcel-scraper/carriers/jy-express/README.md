# JY Express

JY Express parcels use enabled universal providers. There is no dedicated adapter.

JY Express (捷优国际, 广东捷优国际供应链有限公司) is a Guangzhou forwarder shipping goods from China to Amazon
warehouses and buyers abroad, by express, dedicated lines and small-parcel services; its logo reads
JY-EXPRESS and 17TRACK lists it as JY-EXP. It has no bare "JY" alias: 17TRACK gives that name to 佳赢物流, a
China to Russia line.

## Numbers

Its trackers accept three to forty letters, digits, hyphens and underscores, and no public page shows a JY
Express number, so there is no rule. Many of its shipments travel under a partner's number.

## Why there is no adapter

The tracking page on jy-express.cn says its tracking interface is not set up. Its order system's tracking
page, on the NextSLS platform, asks `GET jieyou.nextsls.com/tracking/app?inajax=1&tracking_number=` and gets
JSON, including the last-mile carrier and its number; a made-up number gets a generic failure, and no public
number is known to see a found reply.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
