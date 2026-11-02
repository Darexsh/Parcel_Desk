# Joom Logistics

Joom Logistics parcels use enabled universal providers. There is no dedicated adapter.

Joom Logistics is the Hong Kong logistics arm of the Joom marketplace. It ships parcels from
China, Japan and Korea and tracks them under the numbers of the carriers that carry them,
national posts' S10 numbers and USPS barcodes among them, so no rule names it.

## Tracker

The tracker at joomlogistics.com asks an open JSON interface that needs no account, key or
CAPTCHA. It answers a number it knows with the whole history and the last-mile carrier's number
when that differs, and an unknown one with HTTP 404. Every time is labelled UTC, but the USPS
scans it relays keep their wall clock under the Z: an "OUT FOR DELIVERY" at 06:10Z. A dedicated
adapter could read it once it tells relayed scans from Joom Logistics' own.

## Links

The tracker's `/<language>/track?id=` opens one number, on joomlogistics.com and
logistics.joom.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
