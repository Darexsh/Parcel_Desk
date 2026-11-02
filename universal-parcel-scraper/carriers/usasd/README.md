# SD Group

SD Group parcels use enabled universal providers. There is no dedicated adapter.

SD Group (美国顺达集团), run by S & D Logistics Inc, is a New York forwarder shipping parcels and freight from
the United States to China, from warehouses in Flushing and College Point, New York, and in Massachusetts and
New Jersey. Its site is usasd.com.

## Numbers

Its site gives no layout for its waybill numbers. No public page shows one, so there is no rule.

## Why there is no adapter

Its tracker runs on the DsyExpress forwarding platform and is an open HTML page without a session or CAPTCHA:
`GET www.usasd.com/index.php?c=index&f=search&sn={number}`, one number at a time. An unknown number gets
HTTP 200 with 运单信息不存在 (no such waybill). Older waybills have a second lookup, `f=inquirywaybillData`,
with the same parameter. No public number is known to see a found reply.

## Links

The tracker opens a number from the `sn` parameter of `index.php`, as the home page's search dialog and the
older waybill lookup build it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
