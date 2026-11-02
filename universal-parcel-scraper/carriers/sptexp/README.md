# SPT Express

SPT Express parcels use enabled universal providers. There is no dedicated adapter.

SPT Express is 速派通国际物流 (速派通-辰途国际), a Yiwu forwarder running cross-border parcel lines from China
for e-commerce sellers. Its site is sptexp.com. Universal providers name it SPT. SPT Furniture Logistics, a
Polish furniture carrier, is a separate entry.

## Numbers

No public source shows a whole SPT Express number. A parcel a universal provider files under SPT has `SPT`,
twelve digits and `YQ`, the layout of forwarders on the Hualei (华磊) platform, which open their waybills with
their own code and end them with YQ, as [GZYL](../gzyl/README.md) and
[Xinghe Freight](../xinghe-freight/README.md) do; the corpus holds a made-up number in that shape. `sptexp-1`
rests on that one parcel, so it has low confidence.

## Why there is no adapter

Its site links a tracker on its own tenant of the Hualei (华磊) platform, over plain HTTP on port 8082 of a
bare IP: the platform GZYL's adapter reads through [hualei.ts](../gzyl/hualei.ts). It answers an unknown
number with the platform's not-found. No public reply shows its own status wordings yet.

## Links

No portal link is published, since a plain-HTTP link would leave the number in the clear.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
