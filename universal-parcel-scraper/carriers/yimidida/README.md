# Yimidida

Yimidida parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Waybills are twelve digits: the tracking pages check for exactly twelve digits. Bare
twelve-digit numbers are printed by many carriers, so no Yimidida rule is proposed.

## Links

The home page sends the numbers it is given to the goods-tracking menu page in `params`, so
`www.yimidida.com/demoModel?id=…&params={number}` opens one parcel. That page frames
`www.yimidida.com/usercenter/goods?params={number}`, which reads the same parameter.

## Why there is no adapter

The goods page reads waybills with `POST owsapi.yimidida.com/channelOrder/waybill/queryTraceByValid`,
sending a JSON list of numbers and a header the page computes from the clock, without an
account. When the service answers that a waybill is not the visitor's own, the page asks for
the last four digits of a phone number. Both hosts refuse requests from Europe, Japan, Korea,
Australia and India: Alibaba Cloud's firewall answers HTTP 405 with its block page, to curl and
to a browser alike, while networks in mainland China, Hong Kong, Taiwan, Singapore, the United
States and Brazil get the page. Yimidida's older WeChat tracking pages still load, but the
service behind them no longer answers, and its app is for its network's staff, so Yimidida
stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
