# HY Express

HY Express parcels use enabled universal providers. There is no dedicated adapter.

HY Express (浩远快递), run by Yiwu Lianbao International Freight Forwarding
(义乌市联报国际货运代理有限公司), ships online orders from Yiwu and its other branches in China to
the United States, where USPS and other carriers deliver them, and to the United Kingdom. Its
site is hy-express.com. HYE International Logistics ([`hye`](../hye/README.md)) is a different
company.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

Its tracker runs on the platform [YYpost's adapter](../yypost/rtb56.ts) reads, whose lookup
answers without a session; the page adds a slider CAPTCHA only when it asks for one. No public
number has shown a known parcel's reply yet. An adapter can follow.

## Links

The tracker's `track_query.aspx?track_number=` opens one number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
