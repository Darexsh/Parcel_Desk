# HTT Logistics

HTT Logistics parcels use enabled universal providers. There is no dedicated adapter.

HTT Logistics (昊通国际物流), run by 深圳昊通国际物流有限公司 in Shenzhen, ships online orders from China abroad: its
昊通飞天小包 small-parcel line, cleared through customs at both ends, freight to Amazon warehouses
and sea and air freight, with a warehouse in Los Angeles. Its site writes only the Chinese name; the Latin name follows its domain, httlogistics.com.

## Numbers

Its tracker takes its system numbers, bill of lading numbers and reference numbers, up to thirty
at a time. No public page shows one or states their layout, so there is no rule.

## Why there is no adapter

The tracker on tracking.httlogistics.com is an ASP.NET page whose form posts the numbers back
with the page's view state. It comes from the tracking software vendor 深圳昊天云科技有限公司
(OOPSDON). A tracking directory's name for the carrier, kept as an alias, mixes in that vendor's
brand. No public number has shown a known parcel's reply yet.

## Links

The tracker posts its form back to the same page and ignores numbers in its address, so no
address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
