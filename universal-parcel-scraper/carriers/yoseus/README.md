# Yousheng International Express

Yousheng International Express parcels use enabled universal providers. There is no dedicated adapter.

Yousheng International Express (美国优胜速递, Yoseus) is a forwarder in Monterey Park, California, shipping
online shoppers' parcels from the United States to China. Its site is yoseus.com.

## Numbers

Its site gives no number layout. No public page shows a Yousheng International Express number, so there is no
rule.

## Why there is no adapter

Its tracking page reads an open JSON endpoint without a session or CAPTCHA:
`GET www.yoseus.com/api/me/get_express?order_no={number}`. It answers an unknown number with HTTP 200, an
outer `code` of 1 and an inner `code` of -1 with 没有此单号 (no such number), so an adapter has to read the
inner code. The page shows a found parcel's scans as times and wordings. No public number is known to see a
found reply.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
