# Choosing a provider

[coverage.json](coverage.json) records the evidence and [COVERAGE.md](COVERAGE.md) renders it.
This page says how that evidence becomes an order.

`universalPlan()` takes the eligible providers for a carrier and sorts them by that carrier's
history tier, fuller history first. Within a tier, plain HTTP comes before a browser. Ties
keep the default order. A source that was inconclusive or empty stays eligible. One that
answered with the wrong carrier or refused the format is left out, as long as another usable
source remains. Extra references inform the tiers without changing the comparison table.

Three rules sit on top. Validated China Post C/L postal numbers go to 17TRACK first. Postal
Ninja, when enabled, comes after the other aggregators and never ranks above them, because
many of its histories have no scan a consumer can place; for a named carrier it is asked only
when that carrier's evidence shows its history. UPU needs a valid S10 number and stays
last, because its exchange-office history is sparse.

A provider is called at most once per lookup, with a bounded budget. The aggregators run only
when the consumer selects them, and the facade's default is UPU alone.

[universalPlan](plan.ts) is safe for browsers. Protocol implementations live in each provider
folder. The facade applies the selected provider set, and consumers with their own router can
use the same order with the Node primitives. Persistence, affinity, retries between lookups
and shared cooldowns belong to the consumer.
