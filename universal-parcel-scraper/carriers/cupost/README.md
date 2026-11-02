# CUpost

CUpost parcels use enabled universal providers. There is no dedicated adapter.

CUpost (CU 편의점택배) is the parcel service of CU convenience stores in South Korea, run by BGF
Networks. Parcels are sent and collected at CU stores: domestic parcels, next-day delivery
(CU내일보장택배), a low-cost service from one CU store to another (CU반값택배), collection from
home, international express and online orders sent to a store for pickup. Its site is
cupost.co.kr.

## Numbers

Its tracker takes the invoice number of any of these services, ten to thirteen digits depending
on the service. No public page shows one, and digit runs of these lengths are printed by many
Korean carriers, so there is no rule.

## Why there is no adapter

The result page reads the number from its address and draws its answer on the server, without a
session or CAPTCHA. The site does not answer connections from European or American networks,
only from some others. No public number has shown a known parcel's reply yet.

## Links

Tracking links carry the number as `invoice_no` on the result page for all services,
`allResult.cupost`, or on the older domestic one, `localResult.cupost`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
