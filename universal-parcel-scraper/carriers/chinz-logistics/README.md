# Chinz Logistics

Chinz Logistics parcels use enabled universal providers. There is no dedicated adapter.

Chinz Logistics (秦远国际物流) is an Auckland company that consolidates parcels bought in China and ships them by
air and weekly sea batches to New Zealand and Australia, from warehouses in China, Auckland and Brisbane. It
also clears imports through New Zealand customs, moves container freight and sends parcels from New Zealand to
China. Parcelmate is its consumer brand, with the same tracker and numbers. Its sites are chinzlogistics.com,
chinzlogistics.co.nz and parcelmate.co.nz.

## Numbers

Its tracker looks up order numbers; Parcelmate's help pages say the order number is the tracking number. No
public page shows one, so there is no rule.

## Why there is no adapter

The tracking pages of all three sites read one open JSON API without a session or CAPTCHA:
`GET nz-cn.parcelmate.vip/api/comm/order/logic?ordersns={number}`, which takes a comma-separated list. The pages
read a found order's scans from it and the number of a carrier it was handed to. An unknown number gets HTTP 200
with status `400` in the body. No public number is known to see a found reply.

## Links

The tracking pages open numbers from their `keywords` parameter: `/consult` on chinzlogistics.com, also under
`/en/`, and `/track` on www.chinzlogistics.co.nz and www.parcelmate.co.nz.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
