# MRW

Tracks national MRW shipments through the anonymous form and its history page.

## How it works

A page request establishes an ASP session. The adapter submits the complete
reference, checks the returned summary's own reference, then follows that
shipment's history link and checks the history subtitle. Requests are paced to
respect the portal's rate limit and share one time budget.

## Notes

The portal sometimes returns a bound current summary with no history. That
result is marked `summary_only` and contains no invented scans; the summary's
date and hour still give the current status's wall clock. A page that echoes the
number without a shipment table means MRW has no history for it: the portal shows
the same page for an unknown number and for a shipment outside its lookup range.

The summary can lag the history: a delivery reopened and attempted again is
listed above the delivery the summary still shows. The newest history row
decides when the summary's own row is in the history with only later rows above
it; any other disagreement is inconclusive. Before 10:00 the summary writes the
hour without its leading zero ("9:29") and the history with it, so hours are
padded before they are compared.

A history row whose status the map does not know reads "Actualización de
seguimiento", without a stage, because such wording can name the recipient. The
status map leaves that label out on purpose.

Some history rows are followed by a breakdown of each parcel's own scans. Only
the shipment's rows are read. Hub offices keep their bracketed kind, such as
"(Plataforma)".

History rows name their office by a code and a town. The code opens with the
office's province number: 001 to 048 for mainland Spain and the Balearic
Islands, Ceuta and Melilla included, 052 for Gibraltar and 060 for Andorra, all
on Madrid's clock. Their rows are written on it: a hand-over to a pickup point,
scanned by the courier's office and the point a minute apart, falls within the
point's opening hours on that clock, and not on UTC or Lisbon's. These rows are
dated in `Europe/Madrid`, `Europe/Gibraltar` or `Europe/Andorra`. A clock
skipped when summer time starts stays a wall clock, and one repeated when it
ends reads as its first occurrence. The Canary Islands' offices (049 and 050)
and Portugal's (070 to 089) keep clocks of their own, and nothing shows whether
their rows follow the office's clock or Madrid's, so they keep wall clocks. So
do MRW Points, whose codes name no province: a code shown with a PointCorner
map link marks a point in every row of that history, including later rows that
show it without the link. An office of its town hands a point its parcels, so a
point in the town of an office of the same history takes that office's zone,
unless the town's offices disagree. Rows without an office label and the
summary, which names no office, keep wall clocks too. Node lookups date them on a deduced
zone: the office town's, else the nearest row's ([clocks](../../places/README.md#clocks)).
The newest row's instant is the last update, and the delivery's when it
delivered. Only visible office labels are retained from history rows;
PointCorner map addresses and coordinates are excluded.

The adapter queries www.mrw.es, which words statuses in Spanish. www.mrw.pt renders
the same history in Portuguese; the status map reads both, so relayed Portuguese
wording keeps its stage.

## Testing

Set `MRW_TRACKING_NUMBER` to an authorized reference with history. Optionally
set `MRW_SUMMARY_ONLY_NUMBER` and `MRW_UNKNOWN_NUMBER` for the other observed
response shapes, then run `npm run test:carriers:live -- carriers/mrw`.
