# Danniao Express

Danniao Express parcels use enabled universal providers. There is no dedicated adapter.

Danniao Express (丹鸟速递), run by Zhejiang Danniao Logistics Technology in Hangzhou, delivers
parcels in China. It began as Cainiao's own delivery brand and now runs on STO Express's
systems, with its own tracker and waybill numbers. Its site is danniao.com.

## Numbers

The label example in its archived open-platform documentation shows a waybill number as 621 and
twelve more characters. No public page shows a whole one, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session, which answers several numbers at once
and marks an unknown one as a wrong waybill number. No public number has shown a known parcel's
reply yet. An adapter can follow.

## Links

Tracking links carry the number as `mailNoList` on the home page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
