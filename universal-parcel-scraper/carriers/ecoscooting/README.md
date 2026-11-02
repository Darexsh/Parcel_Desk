# Ecoscooting

Tracks individual parcels in Spain and Portugal through Ecoscooting's official
anonymous tracking client.

## How it works

One bounded form POST uses the Cainiao gateway configuration published in the
website. No account or session bootstrap is needed. The response must identify
the requested parcel. The gateway's query error also occurs for unavailable
orders and remains inconclusive rather than proving absence, with the reason
`portal_not_found`: a label is unknown until the sender announces it. A parcel announced
but not yet handed over is listed without scans, which reads as no history yet
rather than a failure, as Ecoscooting's own page shows it ("No trajectory").
Recognition knows such a parcel, since the listing names it.

The `retry` step sends the form once more when it fails to reach the gateway or
hangs. The first try gets half of the budget, so the retry fits in the rest.

## Notes

Per-scan epoch milliseconds establish instants. Missing epochs retain display
text without borrowing its timezone or an older delivery timestamp. Status
comes from the latest scan. Numeric references use one of two code families:
`GTMS_*`/`TD_*`, or the last-mile `LM_*`/`SL_*`/`SC_*` family that every `CN`
reference (Portuguese `CNPRT`, older Spanish `CNESP`) uses. Either may come
with or without completion flags, and `GTMS_*` scans may carry either family's
wording. A delivery or a collection at a pickup point needs its exact code and
both affirmative labels, and flags, when present, must both affirm it; anything
else stays inconclusive. `GTMS_DEL_FAILURE` also carries the last-mile
family's exception wording ("[Parcel lost]"), which reads as a problem rather than a
failed attempt. Arrival at a pickup point and
the pickup point's own signature ("Delivered to PUDO") read as ready for
pickup. A parcel left at a pickup point past its deadline, and its whole
journey back to the sender, read as returned. The last-mile station lists its
exception or failed attempt first and the return it decides at the same
second; the return then leads the history. The web client names the GTMS
code for that deadline (`GTMS_PUDO_OVERDUE`); only the last-mile one
(`PUDO_OVERDUE`) has been seen in a reply. The gateway no longer answers the
published `CNESP` references.
The labelled gram weight is converted to kilograms. Once a scan places the
parcel at a pickup point, the shop's name and address become `pickup_point`.
They stay after collection so the parcel still shows where it was collected. An
address part the reply spells `NaN` is left out. A
parcel the courier delivers instead (`GTMS_SIGNED`, `LM_SIGN_SUCCESS`) has none,
and neither has a returned one, which no longer waits there.
The pickup PIN, the shop's phone, opening hours and station id are never read.
Destination addresses, postcodes, coordinates, delivery photos, order
identifiers and routing features are excluded. References
start with the destination postcode, after any `CN` country prefix, so samples
and fixtures use zeros there. An 18-digit label is a Spanish postcode, four zeros and
a nine-digit counter. No other carrier's 18-digit numbers in the corpus follow that
layout, so detection names Ecoscooting for it. A label that starts like bpost's
`3232` numbers or Quickpac's `44` ones only puts Ecoscooting first when a number is
recognised. Other 18-digit numbers are not asked: the query error that also
answers a label not yet announced cannot settle that Ecoscooting does not know one.
A `CN` reference typed without its `CN` gets it back before the request and in the
tracking link, since neither Ecoscooting nor Cainiao answers it without, and the
result names the full reference as `canonical_tracking_number`. Without the prefix,
detection asks for the reference's whole layout: the destination, its postcode
(five digits in Spain, seven in Portugal), `1234` and the counter, as every public
reference has it.
SHEIN's package number, `C` or `E`, the order date and eight digits, is the shop's order. The
gateway lists it beside the label Ecoscooting gave the parcel, 18 digits in Spain or a
`CN` reference in Portugal, and the parcel is tracked under that label without naming it,
since the label starts with the delivery postcode. Paack delivers other SHEIN parcels in Spain, so the shape only suggests Ecoscooting,
and recognition asks it; the query error for a package number it never received settles
nothing.
ICP references use a separate client normalization and are not supported.
Cainiao's other `CN` families, such as `CNUSUP`, belong to other networks.

## Live test

Set `ECOSCOOTING_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ecoscooting/adapter.live.test.ts`.
Optionally set `ECOSCOOTING_UNKNOWN_NUMBER` to check an inconclusive query error.
Set `ECOSCOOTING_PORTUGAL_NUMBER` to check the `CN` reference completion schema.
Set `ECOSCOOTING_PICKUP_NUMBER` to a parcel collected at a pickup point to check
that collection reads as delivered and names the pickup point.
